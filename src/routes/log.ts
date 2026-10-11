import { Router } from "express";
import type { Db } from "../db";
import { requireUser } from "../auth";

export function logRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get("/", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const serverId = req.query.serverId ? Number(req.query.serverId) : undefined;
    const rows = serverId
      ? db.prepare("SELECT id, at, username, server_id, server_name, command, ok FROM command_log WHERE server_id = ? ORDER BY id DESC LIMIT ?").all(serverId, limit)
      : db.prepare("SELECT id, at, username, server_id, server_name, command, ok FROM command_log ORDER BY id DESC LIMIT ?").all(limit);
    res.json({ entries: rows });
  });

  return router;
}
