import { test } from "node:test";
import assert from "node:assert/strict";
import { RconConnection, RconPool, decodePackets, encodePacket } from "../src/rcon";
import { startMockRcon } from "./mock-rcon";

test("packets round-trip, including partial reads", () => {
  const a = encodePacket(7, 2, "status");
  const b = encodePacket(8, 0, "hëllo");
  const both = Buffer.concat([a, b]);
  const first = decodePackets(both.subarray(0, a.length + 3));
  assert.deepEqual(first.packets, [{ id: 7, type: 2, body: "status" }]);
  assert.equal(first.rest.length, 3);
  const second = decodePackets(Buffer.concat([first.rest, both.subarray(a.length + 3)]));
  assert.deepEqual(second.packets, [{ id: 8, type: 0, body: "hëllo" }]);
});

test("runs commands and joins multi-packet replies", async () => {
  const long = "x".repeat(10000);
  const mock = await startMockRcon({ password: "pw", handler: (c) => (c === "long" ? long : `ran: ${c}`) });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw" });
  await conn.connect();
  assert.equal(await conn.command("status"), "ran: status");
  assert.equal(await conn.command("long"), long);
  // Commands sent at once still get their own replies.
  const [r1, r2] = await Promise.all([conn.command("a"), conn.command("b")]);
  assert.equal(r1, "ran: a");
  assert.equal(r2, "ran: b");
  conn.close();
  await mock.close();
});

test("wrong password is reported", async () => {
  const mock = await startMockRcon({ password: "pw" });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "nope" });
  await assert.rejects(conn.connect(), /Wrong RCON password/);
  await mock.close();
});

test("unreachable server is reported", async () => {
  const conn = new RconConnection({ host: "127.0.0.1", port: 1, password: "pw", timeoutMs: 1000 });
  await assert.rejects(conn.connect(), /Cannot connect/);
});

test("still answers when the server ignores the end marker", async () => {
  const mock = await startMockRcon({ password: "pw", ignoreEmpty: true });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw", timeoutMs: 2000 });
  await conn.connect();
  assert.equal(await conn.command("status"), "ran: status");
  conn.close();
  await mock.close();
});

test("pool reconnects after the server drops the connection", async () => {
  const mock = await startMockRcon({ password: "pw" });
  const pool = new RconPool();
  const opts = { host: "127.0.0.1", port: mock.port, password: "pw" };
  const [a, b] = await Promise.all([pool.command(1, opts, "one"), pool.command(1, opts, "two")]);
  assert.deepEqual([a, b], ["ran: one", "ran: two"]);
  await mock.close(); // drops the open connection

  const mock2 = await startMockRcon({ password: "pw" });
  const opts2 = { ...opts, port: mock2.port };
  assert.equal(await pool.command(1, opts2, "three"), "ran: three");
  pool.closeAll();
  await mock2.close();
});
