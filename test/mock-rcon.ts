import net from "node:net";
import type { AddressInfo } from "node:net";
import { decodePackets, encodePacket } from "../src/rcon";

export interface MockOptions {
  password: string;
  /** Ignore empty commands, like a server that never answers the end marker. */
  ignoreEmpty?: boolean;
  /** Like CS2: answer the end marker right away but send command output a little later. */
  delayReplyMs?: number;
  /** Reply with this id instead of the request's id. */
  replyId?: number;
  /**
   * Behave like a real CS2 server (seen in its RCON logs): no empty packet before the auth
   * reply, output tagged with the id of the last packet received rather than the command's,
   * followed by an empty packet, and no reply to empty commands.
   */
  cs2?: boolean;
  handler?: (cmd: string) => string;
}

/** A tiny Source RCON server for tests. Records every command it receives. */
export async function startMockRcon(opts: MockOptions) {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      const { packets, rest } = decodePackets(buf);
      buf = rest;
      const lastId = packets.length ? packets[packets.length - 1].id : 0;
      for (const p of packets) {
        if (p.type === 3) {
          if (!opts.cs2) socket.write(encodePacket(p.id, 0, ""));
          authed = p.body === opts.password;
          socket.write(encodePacket(authed ? p.id : -1, 2, ""));
          continue;
        }
        if (!authed || p.type !== 2) continue;
        if (p.body === "") {
          if (!opts.ignoreEmpty && !opts.cs2) socket.write(encodePacket(p.id, 0, ""));
          continue;
        }
        received.push(p.body);
        const reply = opts.handler ? opts.handler(p.body) : `ran: ${p.body}`;
        const id = opts.replyId ?? (opts.cs2 ? lastId : p.id);
        const send = () => {
          // Split long replies over several packets, like a real server does.
          for (let i = 0; i < reply.length || i === 0; i += 4000) {
            socket.write(encodePacket(id, 0, reply.slice(i, i + 4000)));
          }
          if (opts.cs2 && reply !== "") socket.write(encodePacket(id, 0, ""));
        };
        if (opts.delayReplyMs) setTimeout(send, opts.delayReplyMs);
        else send();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
