import path from "node:path";
import express from "express";
import type { Db } from "./db";
import { loadUser } from "./auth";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { serverRoutes } from "./routes/servers";
import { RconPool } from "./rcon";

export interface AppOptions {
  secureCookies?: boolean;
  trustProxy?: boolean;
  rconPool?: RconPool;
}

export function createApp(db: Db, opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxy) app.set("trust proxy", true);

  app.use(express.json({ limit: "100kb" }));
  app.use(loadUser(db));

  // State-changing API calls must be JSON; browsers can't send that cross-site without CORS preflight.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return res.status(415).json({ error: "Expected application/json" });
    }
    next();
  });

  app.use("/api/auth", authRoutes(db, { secureCookies: !!opts.secureCookies }));
  app.use("/api/users", userRoutes(db));
  app.use("/api/servers", serverRoutes(db, opts.rconPool ?? new RconPool()));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  return app;
}
