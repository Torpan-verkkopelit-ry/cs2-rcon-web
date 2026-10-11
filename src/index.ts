import path from "node:path";
import { openDb } from "./db";
import { createApp } from "./app";
import { ensureInitialAdmin } from "./auth";

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const db = openDb(path.join(dataDir, "cs2-rcon-web.db"));

const admin = ensureInitialAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
if (admin) {
  console.log(`Created initial admin account "${admin.username}".`);
  if (admin.password) console.log(`Generated password: ${admin.password}  (change it after logging in)`);
}

const app = createApp(db, {
  secureCookies: process.env.SECURE_COOKIES === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
});

app.listen(port, () => console.log(`CS2 RCON Web listening on http://0.0.0.0:${port}`));
