# CLAUDE.md

Guidance for Claude (and anyone else) working in this repository.

## What this is

CS2 RCON Web: a small web app for running Counter-Strike 2 servers over RCON
from a browser at a LAN event. It runs in Docker on a machine on the LAN;
admins and operators log in from laptops and phones. Users read the README to
set it up, so keep it accurate.

## Stack and layout

- **Backend**: Node.js 22.13+ and TypeScript (strict, CommonJS), Express 4.
  The only runtime dependency is `express`. The database is the built-in
  `node:sqlite` (`DatabaseSync`), so there is no ORM and no native module.
- **Frontend**: plain HTML, CSS and JavaScript in `public/`, served as static
  files. No framework, no bundler, no build step.
- **Tests**: the built-in `node:test` runner with `node:assert/strict`.

```
src/index.ts         entry point: reads env vars, opens the DB, creates the first admin, listens
src/app.ts           createApp(db, opts): middleware, API routers, static files
src/db.ts            openDb() and the MIGRATIONS list
src/auth.ts          password hashing (scrypt), sessions, cookies, requireUser / requireAdmin
src/rcon.ts          Source RCON client (packet encode/decode, RconClient, RconPool)
src/status.ts        parsers for CS2 command output (status, cvars, bans, map groups)
src/routes/*.ts      Express routers: auth, users, servers, log
public/index.html    all views and tabs (login, servers, messages, bans, log, users, account)
public/app.js        all frontend logic
public/style.css     all styles, mobile friendly
test/*.test.ts       tests; test/mock-rcon.ts is a fake RCON server with a `cs2` mode
```

## Commands

```sh
npm install
npm test        # tsc, then node --test on dist/test/**/*.test.js
npm run dev     # build and start on http://localhost:8080, data in ./data
npm run build   # tsc only
docker build -t cs2-rcon-web .
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test` and `docker build`.
It skips changes that only touch docs (`*.md`, `docs/`, `LICENSE`,
`.gitignore`, `docker-compose.yml`); see `paths-ignore` there.
Run `npm test` before every push; it is also the type check.

## Code conventions

- Match the existing style: 2-space indent, double quotes, semicolons, no
  linter or formatter is configured, so follow the surrounding code.
- Use `node:` imports for built-ins (`node:net`, `node:sqlite`, ...).
- Don't add dependencies unless there is no reasonable built-in way. The small
  footprint is deliberate.
- Comments explain *why*, especially for CS2 quirks (e.g. the server replying
  with another packet's id). Keep them short.
- Routers are factory functions (`serverRoutes(db, pool)`) that return a
  `Router`; `createApp` wires them up. Keep that pattern so tests can inject a
  `:memory:` DB and an `RconPool`.
- Validate request bodies in the route and answer errors as
  `res.status(4xx).json({ error: "Human readable message" })`. The UI shows
  `error` to the user as is, so write it for them.
- State-changing API calls must be JSON (`app.ts` rejects anything else as a
  CSRF guard). Protect routes with `requireUser` or `requireAdmin`.
- RCON passwords never go to the browser. Select only public columns (see
  `publicFields` in `routes/servers.ts`).
- Every command sent to a game server goes through the server routes so it is
  written to `command_log`.
- Schema changes go in a **new** entry appended to `MIGRATIONS` in `db.ts`.
  Never edit an existing migration; LAN installs already ran them.
- Parsing of CS2 output belongs in `status.ts` as pure functions with tests
  using real server output samples.

### Frontend

- Vanilla JS in `public/app.js` (`"use strict"`, helpers `$`, `el`, `api`).
  Build DOM with `el()` and `textContent`; never insert user or server text
  with `innerHTML`.
- Tabs are `<div id="tab-..." class="tab">` in `index.html`, switched by
  the URL hash in `showTab()`.
- Buttons that call the API use `withBusy(btn, fn)` for the spinner and
  green/red flash, and results or errors show as toasts.
- Check every UI change at phone width as well as desktop.

### Tests

- Add or update tests for backend changes. API tests start the app on port 0
  with `openDb(":memory:")` and talk to `startMockRcon(...)`; use its `cs2`
  option when behavior depends on how real CS2 servers reply.
- There are no frontend tests; describe how you checked UI changes in the PR.

## Branches

- **`main` is the release branch.** It only ever holds released versions.
  Don't commit or open feature PRs against it.
- **`develop` is the development branch.** Branch from `develop` and open
  pull requests back into `develop`.
- Feature branches are short lived, one feature or fix per PR, and are
  deleted after merging.
- A release is a pull request from `develop` into `main` (see below). Hotfixes
  for a released version branch from `main`, merge into `main` as a patch
  release, and are then merged back into `develop`.

## Changelog and versions

The project uses [Semantic Versioning](https://semver.org/) and a
`CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format.

- Every PR that changes how the tool behaves or is set up adds a line under
  `## [Unreleased]` in `CHANGELOG.md`, in the right group (Added, Changed,
  Fixed, Removed, Security), ending with the PR number like `(#12)`. Write it
  for the people running the tool, not about the code.
- While the version is 0.x: new features bump the minor number, fixes only
  bump the patch number.

### Making a release

1. On `develop`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and add
   a fresh empty `## [Unreleased]` above it.
2. Set `"version"` in `package.json` (and `package-lock.json`, e.g. with
   `npm version x.y.z --no-git-tag-version`) to the same number.
3. Open a PR from `develop` into `main` titled `Release x.y.z` and merge it
   with a merge commit.
4. Tag the merge commit on `main` as `vx.y.z` and create a GitHub release with
   that version's changelog section.

## Docs

- Update `README.md` when setup, settings (env vars) or visible features
  change. New env vars also go in `docker-compose.yml` with a comment.
- Keep the README written for LAN admins: short steps, no internals.

## Pull requests

- Commits and PR titles in plain imperative English, describing the change
  for a user ("Add warmup timer controls").
- PR description: what changes for the user, how it was tested, and the
  changelog line.
- CI must be green before merging.
