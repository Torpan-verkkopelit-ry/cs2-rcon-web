# CS2 RCON Web

A small web app for managing Counter-Strike 2 servers over RCON from a browser, made to run in Docker (for example on a server at a LAN party).

## Status

- [x] Login, user accounts (admin / operator) and password changes
- [x] Add multiple CS2 servers and pick one to manage, raw RCON console
- [ ] Quick controls: change map, game type/mode, exec configs, restart game, warmup
- [ ] Live player list and a log of who ran which command

## Running with Docker

```sh
docker compose up -d --build
docker compose logs cs2-rcon-web   # shows the generated admin password on first start
```

Then open `http://<server-ip>:8080` and log in as `admin`. Change the password under **Account**.

Settings (environment variables in `docker-compose.yml`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the web UI listens on |
| `DATA_DIR` | `/data` | Where the SQLite database is stored (a Docker volume) |
| `ADMIN_USERNAME` | `admin` | First admin account, created only when there are no users |
| `ADMIN_PASSWORD` | *(generated)* | Password for that account; if empty, a random one is printed to the logs |
| `SECURE_COOKIES` | `false` | Set `true` when serving over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` when running behind a reverse proxy |
| `RCON_DEBUG` | `false` | Set `true` to print every RCON packet sent and received to the container logs |

If you ever lock yourself out, stop the container and delete the volume (`docker compose down -v`); a fresh admin account is created on the next start.

## Users

- **Admins** manage users (add, delete, change role, reset passwords) and add, edit and delete servers.
- **Operators** pick a server and run commands on it.

## Servers

Admins add each CS2 server with a name, IP address, port and RCON password. The game server needs an RCON password, set with `rcon_password "yourpassword"` in its `server.cfg` or `+rcon_password yourpassword` on the launch line. The port is the game port, usually 27015 (TCP).

RCON passwords are stored in the app's database so the app can log in to the servers; they are never sent to the browser. Every command is recorded with who ran it and on which server.

## Development

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```sh
npm install
npm test        # builds and runs the tests
npm run dev     # builds and starts on http://localhost:8080, data in ./data
```
