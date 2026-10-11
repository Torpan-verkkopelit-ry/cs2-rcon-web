import { Router } from "express";
import type { Db } from "../db";
import { destroyUserSessions, hashPassword, requireAdmin, validatePassword, validateUsername } from "../auth";

const ROLES = ["admin", "operator"];

export function userRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAdmin);

  const adminCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  const findUser = (id: number) =>
    db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id) as { id: number; username: string; role: string } | undefined;

  router.get("/", (_req, res) => {
    const users = db.prepare("SELECT id, username, role, created_at FROM users ORDER BY username").all();
    res.json({ users });
  });

  router.post("/", (req, res) => {
    const { username, password, role } = req.body ?? {};
    const problem = validateUsername(username) ?? validatePassword(password) ?? (ROLES.includes(role) ? null : "Invalid role");
    if (problem) return res.status(400).json({ error: problem });
    const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
    if (exists) return res.status(409).json({ error: "Username already taken" });
    const result = db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .run(username, hashPassword(password), role);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.patch("/:id", (req, res) => {
    const id = Number(req.params.id);
    const target = findUser(id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const { role, password } = req.body ?? {};

    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
      if (target.role === "admin" && role !== "admin" && adminCount() <= 1) {
        return res.status(400).json({ error: "Cannot remove the last admin" });
      }
    }
    if (password !== undefined) {
      const problem = validatePassword(password);
      if (problem) return res.status(400).json({ error: problem });
    }

    if (role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    if (password !== undefined) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), id);
      destroyUserSessions(db, id, id === req.user!.id ? req.sessionToken : undefined);
    }
    res.json({ ok: true });
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    const target = findUser(id);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (id === req.user!.id) return res.status(400).json({ error: "You cannot delete yourself" });
    if (target.role === "admin" && adminCount() <= 1) return res.status(400).json({ error: "Cannot remove the last admin" });
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  return router;
}
