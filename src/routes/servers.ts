import { Router } from "express";
import type { Db } from "../db";
import { requireAdmin, requireUser } from "../auth";
import { RconPool } from "../rcon";
import { modeName, parseBanList, parseCvarNumber, parseMapGroup, parseStatusJson, parseStatusText } from "../status";

interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  rcon_password: string;
}

const publicFields = "id, name, host, port, created_at";

function validateServer(body: any, requirePassword: boolean): string | null {
  const { name, host, port, rconPassword } = body ?? {};
  if (typeof name !== "string" || !name.trim() || name.length > 64) return "Name is required (max 64 characters)";
  if (typeof host !== "string" || !/^[A-Za-z0-9.\-:\[\]]{1,253}$/.test(host)) return "Enter a valid IP address or hostname";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be 1-65535";
  if (requirePassword || rconPassword !== undefined) {
    if (typeof rconPassword !== "string" || (requirePassword && !rconPassword)) return "RCON password is required";
    if (rconPassword.length > 200) return "RCON password is too long";
  }
  return null;
}

export function serverRoutes(db: Db, pool: RconPool): Router {
  const router = Router();
  router.use(requireUser);

  // Servers whose `status_json` didn't return JSON; for those we only use `status`.
  const noStatusJson = new Set<number>();

  const findServer = (id: number) => db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;

  router.get("/", (_req, res) => {
    res.json({ servers: db.prepare(`SELECT ${publicFields} FROM servers ORDER BY name COLLATE NOCASE`).all() });
  });

  router.post("/", requireAdmin, (req, res) => {
    const problem = validateServer(req.body, true);
    if (problem) return res.status(400).json({ error: problem });
    const { name, host, port, rconPassword } = req.body;
    const result = db
      .prepare("INSERT INTO servers (name, host, port, rcon_password) VALUES (?, ?, ?, ?)")
      .run(name.trim(), host, port, rconPassword);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put("/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!findServer(id)) return res.status(404).json({ error: "Server not found" });
    // An empty or missing password keeps the current one.
    const body = { ...req.body };
    if (!body.rconPassword) delete body.rconPassword;
    const problem = validateServer(body, false);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare("UPDATE servers SET name = ?, host = ?, port = ? WHERE id = ?").run(body.name.trim(), body.host, body.port, id);
    if (body.rconPassword) db.prepare("UPDATE servers SET rcon_password = ? WHERE id = ?").run(body.rconPassword, id);
    pool.drop(id);
    noStatusJson.delete(id);
    res.json({ ok: true });
  });

  router.delete("/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!findServer(id)) return res.status(404).json({ error: "Server not found" });
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    pool.drop(id);
    res.json({ ok: true });
  });

  router.post("/:id/command", async (req, res) => {
    const server = findServer(Number(req.params.id));
    if (!server) return res.status(404).json({ error: "Server not found" });
    const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
    if (!command) return res.status(400).json({ error: "Command is required" });
    if (command.length > 1000) return res.status(400).json({ error: "Command is too long" });

    const log = (ok: boolean) =>
      db
        .prepare("INSERT INTO command_log (user_id, username, server_id, server_name, command, ok) VALUES (?, ?, ?, ?, ?, ?)")
        .run(req.user!.id, req.user!.username, server.id, server.name, command, ok ? 1 : 0);

    try {
      const response = await pool.command(server.id, { host: server.host, port: server.port, password: server.rcon_password }, command);
      log(true);
      res.json({ response });
    } catch (err) {
      log(false);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Polled by the UI for the player list, so it isn't written to the command log.
  // Players come from `status`, whose format is known from real CS2 servers; `status_json`
  // only fills in server details that `status` didn't show (it can leave out human players).
  router.get("/:id/status", async (req, res) => {
    const server = findServer(Number(req.params.id));
    if (!server) return res.status(404).json({ error: "Server not found" });
    const opts = { host: server.host, port: server.port, password: server.rcon_password };
    const run = (cmd: string) => pool.command(server.id, opts, cmd);
    try {
      const status = parseStatusText(await run("status"));
      if ((!status.map || !status.hostname || !status.maxPlayers) && !noStatusJson.has(server.id)) {
        const json = parseStatusJson(await run("status_json"));
        if (json) {
          status.map ??= json.map;
          status.hostname ??= json.hostname;
          status.maxPlayers ??= json.maxPlayers;
        } else {
          noStatusJson.add(server.id);
        }
      }
      status.gameType = parseCvarNumber(await run("game_type"), "game_type");
      status.gameMode = parseCvarNumber(await run("game_mode"), "game_mode");
      status.modeName = modeName(status.gameType, status.gameMode);
      res.json(status);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Maps in the server's current map group, for the map picker. Not written to the command log.
  router.get("/:id/maps", async (req, res) => {
    const server = findServer(Number(req.params.id));
    if (!server) return res.status(404).json({ error: "Server not found" });
    const opts = { host: server.host, port: server.port, password: server.rcon_password };
    try {
      res.json(parseMapGroup(await pool.command(server.id, opts, "print_mapgroup_sv")));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get("/:id/bans", async (req, res) => {
    const server = findServer(Number(req.params.id));
    if (!server) return res.status(404).json({ error: "Server not found" });
    const opts = { host: server.host, port: server.port, password: server.rcon_password };
    try {
      const steamIds = parseBanList(await pool.command(server.id, opts, "listid"));
      const ips = parseBanList(await pool.command(server.id, opts, "listip"));
      res.json({ steamIds, ips });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}
