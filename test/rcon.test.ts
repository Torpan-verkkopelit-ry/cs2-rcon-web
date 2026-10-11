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

test("reads replies from a CS2-like server", async () => {
  const long = "y".repeat(9000);
  const mock = await startMockRcon({ password: "pw", cs2: true, handler: (c) => (c === "long" ? long : c === "quiet" ? "" : `ran: ${c}`) });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw" });
  await conn.connect();
  assert.equal(await conn.command("status"), "ran: status");
  assert.equal(await conn.command("long"), long);
  assert.equal(await conn.command("quiet"), "");
  assert.equal(await conn.command("users"), "ran: users");
  conn.close();
  await mock.close();
});

test("waits for output that arrives late", async () => {
  const mock = await startMockRcon({ password: "pw", delayReplyMs: 200 });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw" });
  await conn.connect();
  assert.equal(await conn.command("status"), "ran: status");
  assert.equal(await conn.command("mp_warmup_end"), "ran: mp_warmup_end");
  conn.close();
  await mock.close();
});

test("accepts replies that come back with id 0", async () => {
  const mock = await startMockRcon({ password: "pw", replyId: 0 });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw" });
  await conn.connect();
  assert.equal(await conn.command("status"), "ran: status");
  assert.equal(await conn.command("users"), "ran: users");
  conn.close();
  await mock.close();
});

test("commands with no output finish without an error", async () => {
  const mock = await startMockRcon({ password: "pw", handler: () => "" });
  const conn = new RconConnection({ host: "127.0.0.1", port: mock.port, password: "pw" });
  await conn.connect();
  assert.equal(await conn.command("mp_restartgame 1"), "");
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
