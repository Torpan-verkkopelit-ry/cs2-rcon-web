import { Router } from "express";
import type { Db } from "../db";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  requireUser,
  validatePassword,
  verifyPassword,
} from "../auth";

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function authRoutes(db: Db, opts: { secureCookies: boolean }): Router {
  const router = Router();
  const failures = new Map<string, { count: number; since: number }>();

  router.post("/login", (req, res) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const f = failures.get(ip);
    if (f && now - f.since < FAILURE_WINDOW_MS && f.count >= MAX_FAILURES) {
      return res.status(429).json({ error: "Too many failed logins, try again later" });
    }

    const { username, password } = req.body ?? {};
    const row =
      typeof username === "string"
        ? (db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username) as
            | { id: number; password_hash: string }
            | undefined)
        : undefined;

    if (!row || typeof password !== "string" || !verifyPassword(password, row.password_hash)) {
      const entry = f && now - f.since < FAILURE_WINDOW_MS ? f : { count: 0, since: now };
      entry.count++;
      failures.set(ip, entry);
      return res.status(401).json({ error: "Wrong username or password" });
    }

    failures.delete(ip);
    const { token, expiresAt } = createSession(db, row.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: opts.secureCookies,
      expires: new Date(expiresAt),
      path: "/",
    });
    res.json({ ok: true });
  });

  router.post("/logout", (req, res) => {
    if (req.sessionToken) destroySession(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/me", requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  router.post("/password", requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user!.id) as { password_hash: string };
    if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ error: "Current password is wrong" });
    }
    const problem = validatePassword(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), req.user!.id);
    destroyUserSessions(db, req.user!.id, req.sessionToken);
    res.json({ ok: true });
  });

  return router;
}
