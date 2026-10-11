import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb, type Db } from "../src/db";
import { createApp } from "../src/app";
import { ensureInitialAdmin } from "../src/auth";
import { RconPool } from "../src/rcon";
import { startMockRcon } from "./mock-rcon";

let server: Server;
let base: string;
let db: Db;
const pool = new RconPool();
let mock: Awaited<ReturnType<typeof startMockRcon>>;

before(async () => {
  db = openDb(":memory:");
  ensureInitialAdmin(db, "admin", "adminpass1");
  server = createApp(db, { rconPool: pool }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock = await startMockRcon({ password: "rconpw" });
});

after(async () => {
  pool.closeAll();
  server.close();
  await mock.close();
});

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function login(username: string, password: string) {
  return (await call("POST", "/api/auth/login", { username, password })).cookie!;
}

test("admin adds servers; operators can use but not edit them", async () => {
  const admin = await login("admin", "adminpass1");
  await call("POST", "/api/users", { username: "op", password: "operator1", role: "operator" }, admin);
  const op = await login("op", "operator1");

  assert.equal((await call("POST", "/api/servers", { name: "S", host: "127.0.0.1", port: 27015 }, admin)).status, 400);
  assert.equal((await call("POST", "/api/servers", { name: "S", host: "bad host!", port: 27015, rconPassword: "x" }, admin)).status, 400);
  const created = await call("POST", "/api/servers", { name: "Main", host: "127.0.0.1", port: mock.port, rconPassword: "rconpw" }, admin);
  assert.equal(created.status, 201);
  assert.equal((await call("POST", "/api/servers", { name: "X", host: "127.0.0.1", port: 1, rconPassword: "x" }, op)).status, 403);

  const list = await call("GET", "/api/servers", undefined, op);
  assert.equal(list.json.servers.length, 1);
  assert.equal(list.json.servers[0].name, "Main");
  assert.equal(list.json.servers[0].rcon_password, undefined, "password is never sent to the browser");

  const r = await call("POST", `/api/servers/${created.json.id}/command`, { command: "status" }, op);
  assert.equal(r.status, 200);
  assert.equal(r.json.response, "ran: status");

  const logged = db.prepare("SELECT username, server_name, command, ok FROM command_log").all();
  assert.deepEqual(logged.map((x) => ({ ...x })), [{ username: "op", server_name: "Main", command: "status", ok: 1 }]);
});

test("editing keeps the password when left empty; wrong password gives an error", async () => {
  const admin = await login("admin", "adminpass1");
  const { json } = await call("POST", "/api/servers", { name: "Two", host: "127.0.0.1", port: mock.port, rconPassword: "rconpw" }, admin);
  const id = json.id;

  assert.equal((await call("PUT", `/api/servers/${id}`, { name: "Two!", host: "127.0.0.1", port: mock.port, rconPassword: "" }, admin)).status, 200);
  assert.equal((await call("POST", `/api/servers/${id}/command`, { command: "echo hi" }, admin)).json.response, "ran: echo hi");

  assert.equal((await call("PUT", `/api/servers/${id}`, { name: "Two!", host: "127.0.0.1", port: mock.port, rconPassword: "wrong" }, admin)).status, 200);
  const bad = await call("POST", `/api/servers/${id}/command`, { command: "echo hi" }, admin);
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /Wrong RCON password/);

  assert.equal((await call("DELETE", `/api/servers/${id}`, {}, admin)).status, 200);
  assert.equal((await call("POST", `/api/servers/${id}/command`, { command: "x" }, admin)).status, 404);
});

test("status endpoint falls back to text status; log lists commands", async () => {
  const statusMock = await startMockRcon({
    password: "pw",
    handler: (c) =>
      ({
        status_json: "Unknown command 'status_json'!",
        status: "hostname : LAN\n    2    00:10   12    0     active 786432 10.0.0.9:27005 'Aki'\n",
        game_type: "game_type = 0",
        game_mode: '"game_mode" = "2" ( def. "0" ) game replicated',
        listid: "ID filter list: 1 entry\n1 [U:1:12345] : permanent\n",
        listip: "IP filter list: empty\n",
      })[c] ?? "",
  });
  const admin = await login("admin", "adminpass1");
  const { json } = await call("POST", "/api/servers", { name: "Status", host: "127.0.0.1", port: statusMock.port, rconPassword: "pw" }, admin);
  for (let i = 0; i < 2; i++) {
    const r = await call("GET", `/api/servers/${json.id}/status`, undefined, admin);
    assert.equal(r.status, 200);
    assert.equal(r.json.hostname, "LAN");
    assert.deepEqual(r.json.players.map((p: any) => p.name), ["Aki"]);
  }
  // status_json is only tried once per server.
  assert.deepEqual(statusMock.received, ["status", "status_json", "game_type", "game_mode", "status", "game_type", "game_mode"]);

  const st = await call("GET", `/api/servers/${json.id}/status`, undefined, admin);
  assert.deepEqual([st.json.gameType, st.json.gameMode, st.json.modeName], [0, 2, "Wingman"]);

  const bans = await call("GET", `/api/servers/${json.id}/bans`, undefined, admin);
  assert.deepEqual(bans.json, { steamIds: [{ id: "[U:1:12345]", duration: "permanent" }], ips: [] });

  await call("POST", `/api/servers/${json.id}/command`, { command: "mp_warmup_end" }, admin);
  const log = await call("GET", `/api/log?serverId=${json.id}`, undefined, admin);
  assert.deepEqual(log.json.entries.map((e: any) => [e.username, e.command, e.ok]), [["admin", "mp_warmup_end", 1]]);
  assert.equal((await call("GET", "/api/log")).status, 401);
  pool.drop(json.id);
  await statusMock.close();
});
