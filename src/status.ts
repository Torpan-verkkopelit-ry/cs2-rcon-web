export interface Player {
  /** userid for `kickid`, when the server reports one. */
  id?: number;
  name: string;
  bot: boolean;
  ping?: number;
  /** Connected time as the server prints it, e.g. "12:34". */
  time?: string;
  steamId?: string;
  address?: string;
}

export interface ServerStatus {
  hostname?: string;
  map?: string;
  maxPlayers?: number;
  players: Player[];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Parses the JSON printed by CS2's `status_json`. Returns undefined if `text` isn't that. */
export function parseStatusJson(text: string): ServerStatus | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let data: any;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;

  const server = data.server ?? {};
  const clients: any[] = Array.isArray(data.clients) ? data.clients : Array.isArray(server.clients) ? server.clients : Array.isArray(data.players) ? data.players : [];
  const players = clients
    .filter((c) => c && typeof c === "object" && typeof c.name === "string")
    .map((c): Player => {
      const steamId = str(c.steamid64) ?? str(c.steamid) ?? (typeof c.steamid64 === "number" ? String(c.steamid64) : undefined);
      const time = num(c.time);
      return {
        id: num(c.userid) ?? num(c.id) ?? num(c.slot),
        name: c.name,
        bot: c.bot === true || c.is_bot === true || steamId === "0",
        ping: num(c.ping),
        time: time !== undefined ? formatSeconds(time) : str(c.time),
        steamId: steamId === "0" ? undefined : steamId,
        address: str(c.address) ?? str(c.ip),
      };
    });

  return {
    hostname: str(server.name) ?? str(server.hostname) ?? str(data.hostname),
    map: str(server.map) ?? str(data.map),
    maxPlayers: num(server.max_players) ?? num(server.maxplayers),
    players,
  };
}

/** Parses the text printed by `status` (CS2, with a CS:GO-style fallback for player lines). */
export function parseStatusText(text: string): ServerStatus {
  const status: ServerStatus = { players: [] };
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const kv = line.match(/^\s*(hostname|map|players)\s*:\s*(.*)$/i);
    if (kv) {
      const key = kv[1].toLowerCase();
      if (key === "hostname") status.hostname = kv[2].trim();
      if (key === "map") status.map = kv[2].trim().split(/\s+/)[0];
      if (key === "players") status.maxPlayers = num(kv[2].match(/\((\d+)\s*max/i)?.[1]);
      continue;
    }

    // CS2 loads the map as a spawngroup: "loaded spawngroup(  1)  : SV:  [1: de_dust2 | main lump | mapload]"
    const spawn = line.match(/spawngroup.*\[\d+:\s*([^\s|\]]+)\s*\|\s*main lump/i);
    if (spawn && !status.map) {
      status.map = spawn[1];
      continue;
    }

    // CS2:  "    2    01:23   24    0     active 786432 10.0.0.5:27005 'Aki'"
    //       "    3      BOT    0    0     active      0 'Bot Name'"
    const cs2 = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*(\S*?)\s+'(.*)'\s*$/);
    if (cs2) {
      const [, id, time, ping, , state, , address, name] = cs2;
      if (state === "challenging" || Number(id) === 65535) continue;
      const bot = time === "BOT";
      status.players.push({
        id: Number(id),
        name,
        bot,
        ping: Number(ping),
        time: bot ? undefined : time,
        address: address && address.includes(":") ? address : undefined,
      });
      continue;
    }

    // CS:GO: "# 2 1 "Aki" STEAM_1:0:123 01:23 24 0 active 786432 10.0.0.5:27005"
    const csgo = line.match(/^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)\s*(.*)$/);
    if (csgo) {
      const [, id, name, uid, rest] = csgo;
      const bot = uid === "BOT";
      const parts = rest.trim().split(/\s+/);
      status.players.push({
        id: Number(id),
        name,
        bot,
        steamId: bot ? undefined : uid,
        time: bot ? undefined : parts[0],
        ping: bot ? undefined : num(parts[1]),
        address: parts.find((p) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(p)),
      });
    }
  }
  return status;
}
