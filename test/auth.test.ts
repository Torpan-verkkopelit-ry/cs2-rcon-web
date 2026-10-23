import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db";
import { createApp } from "../src/app";
import { ensureInitialAdmin, hashPassword, verifyPassword } from "../src/auth";

let server: Server;
let base: string;

before(async () => {
  const db = openDb(":memory:");
  ensureInitialAdmin(db, "admin", "adminpass1");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json: (await res.json()) as any, cookie: setCookie?.split(";")[0] };
}

async function login(username: string, password: string) {
  const r = await call("POST", "/api/auth/login", { username, password });
  assert.equal(r.status, 200, `login ${username}`);
  return r.cookie!;
}

test("password hashing round-trips", () => {
  const h = hashPassword("secret123");
  assert.ok(verifyPassword("secret123", h));
  assert.ok(!verifyPassword("wrong", h));
});

test("initial admin is only created once", () => {
  const db = openDb(":memory:");
  const first = ensureInitialAdmin(db);
  assert.equal(first?.username, "admin");
  assert.ok(first?.password && first.password.length >= 12);
  assert.equal(ensureInitialAdmin(db), null);
});

test("unauthenticated requests are rejected", async () => {
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
  assert.equal((await call("GET", "/api/users")).status, 401);
});

test("Brotli-encoded request bodies are refused", async () => {
  // Express 4 never decompresses Brotli bodies; keep it that way (CVE-2026-111497).
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
    body: Buffer.from([0x0b, 0x02, 0x80, 0x7b, 0x7d, 0x03]),
  });
  assert.equal(res.status, 415);
});

test("wrong password is rejected", async () => {
  const r = await call("POST", "/api/auth/login", { username: "admin", password: "nope" });
  assert.equal(r.status, 401);
});

test("non-JSON writes are rejected", async () => {
  const res = await fetch(base + "/api/auth/login", { method: "POST", body: "username=admin&password=adminpass1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 415);
});

test("admin manages users; operator cannot", async () => {
  const admin = await login("admin", "adminpass1");
  assert.equal((await call("GET", "/api/auth/me", undefined, admin)).json.user.role, "admin");

  const created = await call("POST", "/api/users", { username: "op1", password: "operator1", role: "operator" }, admin);
  assert.equal(created.status, 201);
  assert.equal((await call("POST", "/api/users", { username: "OP1", password: "operator1", role: "operator" }, admin)).status, 409);
  assert.equal((await call("POST", "/api/users", { username: "x", password: "short", role: "operator" }, admin)).status, 400);

  const op = await login("op1", "operator1");
  assert.equal((await call("GET", "/api/users", undefined, op)).status, 403);

  // Admin resets the operator's password: old session is dropped.
  assert.equal((await call("PATCH", `/api/users/${created.json.id}`, { password: "newpass123" }, admin)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, op)).status, 401);
  await login("op1", "newpass123");

  assert.equal((await call("DELETE", `/api/users/${created.json.id}`, {}, admin)).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { username: "op1", password: "newpass123" })).status, 401);
});

test("last admin cannot be demoted or deleted", async () => {
  const admin = await login("admin", "adminpass1");
  const me = (await call("GET", "/api/auth/me", undefined, admin)).json.user;
  assert.equal((await call("PATCH", `/api/users/${me.id}`, { role: "operator" }, admin)).status, 400);
  assert.equal((await call("DELETE", `/api/users/${me.id}`, {}, admin)).status, 400);
});

test("user changes own password and logs out", async () => {
  const admin = await login("admin", "adminpass1");
  await call("POST", "/api/users", { username: "op2", password: "operator2", role: "operator" }, admin);
  const op = await login("op2", "operator2");
  assert.equal((await call("POST", "/api/auth/password", { currentPassword: "bad", newPassword: "operator22" }, op)).status, 400);
  assert.equal((await call("POST", "/api/auth/password", { currentPassword: "operator2", newPassword: "operator22" }, op)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, op)).status, 200);
  assert.equal((await call("POST", "/api/auth/logout", {}, op)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, op)).status, 401);
  await login("op2", "operator22");
});
