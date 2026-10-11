import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "./db";

export type Role = "admin" | "operator";

export interface User {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export const SESSION_COOKIE = "cs2rcon_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 200) return "Password is too long";
  return null;
}

export function validateUsername(username: unknown): string | null {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) {
    return "Username must be 2-32 characters: letters, numbers, _ . -";
  }
  return null;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(db: Db, userId: number): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, expiresAt);
  return { token, expiresAt };
}

export function destroySession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function destroyUserSessions(db: Db, userId: number, exceptToken?: string): void {
  if (exceptToken) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, sha256(exceptToken));
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function userForToken(db: Db, token: string): User | undefined {
  return db
    .prepare(
      `SELECT u.id, u.username, u.role, u.created_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as User | undefined;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

export function loadUser(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = userForToken(db, token);
      if (user) {
        req.user = user;
        req.sessionToken = token;
      }
    }
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admins only" });
  next();
}

/** Creates the first admin account when the database has no users. Returns the generated password, if any. */
export function ensureInitialAdmin(db: Db, username?: string, password?: string): { username: string; password?: string } | null {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n > 0) return null;
  const name = username || "admin";
  const generated = password ? undefined : crypto.randomBytes(12).toString("base64url");
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(name, hashPassword(password || generated!));
  return { username: name, password: generated };
}
