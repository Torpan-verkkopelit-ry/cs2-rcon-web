# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Add an entry under **Unreleased** in every pull request that changes how the
tool behaves or how it is set up.

## [Unreleased]

## [0.1.0] - 2026-10-11

First version, used for setting up the tool at the LAN.

### Added

- Login with cookie sessions and scrypt-hashed passwords; admin and operator
  roles, user management, and a generated admin password on first start (#1).
- Docker image and `docker-compose.yml`, with data kept in the
  `cs2-rcon-data` volume (#1).
- Servers list that admins can add to, edit and delete, and an RCON console
  with command history for every user (#2).
- `RCON_DEBUG` setting that logs raw RCON packets (#2).
- Quick controls: map and game mode picker (including Workshop maps), config
  exec and one-click match commands (#3).
- Player list with IP addresses, kick and auto-refresh, plus a bans card that
  lists and removes SteamID and IP bans (#3).
- Log tab showing who ran which command (#3).
- LAN setup guide in the README (#4).

### Fixed

- CS2 command output was missing because the server replies with another
  packet's id or answers after the end marker (#2).
- Human players were missing from the player list on some modes (#3).
