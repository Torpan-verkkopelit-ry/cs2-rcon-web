import net from "node:net";

// Source RCON protocol: https://developer.valvesoftware.com/wiki/Source_RCON_Protocol
const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

interface Packet {
  id: number;
  type: number;
  body: string;
}

export class RconError extends Error {}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + bodyBuf.length);
  buf.writeInt32LE(10 + bodyBuf.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // Two trailing null bytes are already zero from Buffer.alloc.
  return buf;
}

/** Splits complete packets off the front of `buf`; returns the packets and any leftover bytes. */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const size = buf.readInt32LE(offset);
    if (size < 10 || size > 1024 * 1024) throw new RconError(`Invalid RCON packet size ${size}`);
    if (buf.length - offset < 4 + size) break;
    const id = buf.readInt32LE(offset + 4);
    const type = buf.readInt32LE(offset + 8);
    const body = buf.toString("utf8", offset + 12, offset + 4 + size - 2);
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buf.subarray(offset) };
}

type Pending = {
  id: number;
  markerId: number;
  chunks: string[];
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  quiet?: NodeJS.Timeout;
  grace?: NodeJS.Timeout;
};

/** A reply counts as complete after this long without new packets. */
const QUIET_MS = 300;
/** How long to keep waiting for output when the end marker is answered before the command itself. */
const MARKER_GRACE_MS = 1500;

const debug = process.env.RCON_DEBUG === "1" || process.env.RCON_DEBUG === "true";

/**
 * One authenticated RCON connection. Commands are sent one at a time.
 *
 * Responses can be split over several packets, so after each command we send an empty
 * command as an end marker: once its (empty) reply arrives, everything for the real
 * command has been received.
 *
 * CS2 doesn't follow that reliably: it can answer the empty marker before the real command
 * has run, and may not answer the marker at all. So a reply also counts as complete after a
 * short pause following its last packet, and a marker answered early only starts a grace
 * period in which the real output can still arrive.
 */
export class RconConnection {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending?: Pending;
  private authWaiter?: { id: number; resolve: () => void; reject: (e: Error) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private opts: RconOptions) {}

  private authenticated = false;

  get isOpen(): boolean {
    return this.authenticated && !this.closed;
  }

  /** True once login succeeded, even if the connection has dropped since. */
  get wasConnected(): boolean {
    return this.authenticated;
  }

  async connect(): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: this.opts.host, port: this.opts.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new RconError(`Timed out connecting to ${this.opts.host}:${this.opts.port}`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(new RconError(`Cannot connect to ${this.opts.host}:${this.opts.port}: ${err.message}`));
      });
    });

    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (data) => this.onData(data));
    socket.on("error", (err) => this.fail(new RconError(`Connection error: ${err.message}`)));
    socket.on("close", () => this.fail(new RconError("Connection closed by server")));

    const id = this.id();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authWaiter = undefined;
        reject(new RconError("Timed out waiting for RCON login"));
        this.close();
      }, timeoutMs);
      this.authWaiter = {
        id,
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      socket.write(encodePacket(id, SERVERDATA_AUTH, this.opts.password));
    });
  }

  /** Runs a command and resolves with the server's full text response. */
  command(cmd: string): Promise<string> {
    const run = () => this.send(cmd);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.fail(new RconError("Connection closed"));
  }

  private send(cmd: string): Promise<string> {
    if (!this.isOpen) return Promise.reject(new RconError("Not connected"));
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    return new Promise<string>((resolve, reject) => {
      const id = this.id();
      const markerId = this.id();
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new RconError("Timed out waiting for response"));
      }, timeoutMs);
      this.pending = { id, markerId, chunks: [], resolve, reject, timer };
      if (debug) console.log(`[rcon ${this.opts.host}:${this.opts.port}] send id=${id} marker=${markerId} ${JSON.stringify(cmd)}`);
      this.socket!.write(Buffer.concat([encodePacket(id, SERVERDATA_EXECCOMMAND, cmd), encodePacket(markerId, SERVERDATA_EXECCOMMAND, "")]));
    });
  }

  private id(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    return id;
  }

  private onData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    let packets: Packet[];
    try {
      ({ packets, rest: this.buffer } = decodePackets(this.buffer));
    } catch (err) {
      this.fail(err as Error);
      this.socket?.destroy();
      return;
    }
    for (const p of packets) this.onPacket(p);
  }

  private onPacket(p: Packet) {
    if (debug) {
      const preview = p.body.length > 200 ? `${p.body.slice(0, 200)}...` : p.body;
      console.log(`[rcon ${this.opts.host}:${this.opts.port}] recv id=${p.id} type=${p.type} len=${p.body.length} ${JSON.stringify(preview)}`);
    }
    if (this.authWaiter) {
      // The server sends an empty RESPONSE_VALUE before the AUTH_RESPONSE; ignore it.
      if (p.type !== SERVERDATA_AUTH_RESPONSE) return;
      const waiter = this.authWaiter;
      this.authWaiter = undefined;
      if (p.id === -1) {
        waiter.reject(new RconError("Wrong RCON password"));
        this.close();
      } else {
        this.authenticated = true;
        waiter.resolve();
      }
      return;
    }

    const pending = this.pending;
    if (!pending || p.type !== SERVERDATA_RESPONSE_VALUE) return;
    if (p.id === pending.markerId) {
      if (pending.chunks.some((c) => c !== "")) this.finish(pending);
      else if (!pending.grace) pending.grace = setTimeout(() => this.finish(pending), MARKER_GRACE_MS);
    } else if (p.id === pending.id || p.id > pending.markerId || p.id <= 0) {
      // Commands run one at a time, so ids we didn't hand out (CS2 can reply with 0) belong to
      // the current command. Smaller positive ids are late replies to earlier commands.
      pending.chunks.push(p.body);
      if (pending.quiet) clearTimeout(pending.quiet);
      // An empty packet may come before the real output, so give that a little longer.
      pending.quiet = setTimeout(() => this.finish(pending), p.body === "" && !pending.grace ? MARKER_GRACE_MS : QUIET_MS);
    }
  }

  private finish(pending: Pending) {
    if (this.pending !== pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.quiet) clearTimeout(pending.quiet);
    if (pending.grace) clearTimeout(pending.grace);
    pending.resolve(pending.chunks.join(""));
  }

  private fail(err: Error) {
    this.closed = true;
    if (this.authWaiter) {
      const w = this.authWaiter;
      this.authWaiter = undefined;
      w.reject(err);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      clearTimeout(p.timer);
      if (p.quiet) clearTimeout(p.quiet);
      if (p.grace) clearTimeout(p.grace);
      // A server that drops the connection right after replying (e.g. on "quit") still answered.
      if (p.chunks.length > 0) p.resolve(p.chunks.join(""));
      else p.reject(err);
    }
  }
}

/** Keeps one connection per game server, reconnecting when needed and closing idle ones. */
export class RconPool {
  private conns = new Map<number, { conn: RconConnection; key: string; ready: Promise<void>; idle?: NodeJS.Timeout }>();

  constructor(private idleMs = 5 * 60 * 1000) {}

  async command(serverId: number, opts: RconOptions, cmd: string): Promise<string> {
    const key = `${opts.host}:${opts.port}:${opts.password}`;
    let entry = this.conns.get(serverId);
    if (entry && (entry.key !== key || (!entry.conn.isOpen && entry.conn.wasConnected))) {
      this.drop(serverId);
      entry = undefined;
    }
    if (!entry) {
      const conn = new RconConnection(opts);
      const created = { conn, key, ready: conn.connect() };
      entry = created;
      this.conns.set(serverId, created);
      created.ready.catch(() => {
        if (this.conns.get(serverId) === created) this.drop(serverId);
      });
    }
    await entry.ready;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.drop(serverId), this.idleMs);
    entry.idle.unref();
    return entry.conn.command(cmd);
  }

  drop(serverId: number): void {
    const entry = this.conns.get(serverId);
    if (!entry) return;
    if (entry.idle) clearTimeout(entry.idle);
    entry.conn.close();
    this.conns.delete(serverId);
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.drop(id);
  }
}
