import { test } from "node:test";
import assert from "node:assert/strict";
import { modeName, parseBanList, parseCvarNumber, parseStatusJson, parseStatusText } from "../src/status";

const CS2_STATUS = `Server:  Running [10.0.0.223:27015]
Client:  Disconnected
----- Status -----
@ Current  :  game
source   : console
hostname : TorppaLAN - LANIT
spawn    : 2
version  : 1.41.9.0/14190 10924 insecure  public
steamid  : [G:1:1234567]
udp/ip   : 10.0.0.223:27015
os/type  : Linux dedicated
players  : 2 humans, 1 bots (10 max) (not hibernating) (unreserved)
loaded spawngroup(  1)  : SV:  [1: de_mirage | main lump | mapload]

---------players--------
  id     time ping loss      state   rate adr name
65535 [NoChan]    0    0 challenging      0unknown ''
    2    12:34   24    0     active 786432 10.0.0.5:27005 'Aki'
    3    01:02:03   5    0     active 786432 10.0.0.6:27005 'Kalle the Great'
    4      BOT    0    0     active      0 'Bot Mike'
#end
`;

test("parses CS2 status text", () => {
  const s = parseStatusText(CS2_STATUS);
  assert.equal(s.hostname, "TorppaLAN - LANIT");
  assert.equal(s.map, "de_mirage");
  assert.equal(s.maxPlayers, 10);
  assert.deepEqual(
    s.players.map((p) => [p.id, p.name, p.bot, p.ping, p.time, p.address]),
    [
      [2, "Aki", false, 24, "12:34", "10.0.0.5:27005"],
      [3, "Kalle the Great", false, 5, "01:02:03", "10.0.0.6:27005"],
      [4, "Bot Mike", true, 0, undefined, undefined],
    ],
  );
});

test("parses CS:GO-style status player lines", () => {
  const s = parseStatusText(`hostname: Old Server
map     : de_dust2 at: 0 x, 0 y, 0 z
# userid name uniqueid connected ping loss state rate adr
#  2 1 "Aki" STEAM_1:0:123 01:23 24 0 active 786432 10.0.0.5:27005
#  3 "Bot" BOT active 64
`);
  assert.equal(s.map, "de_dust2");
  assert.deepEqual(
    s.players.map((p) => [p.id, p.name, p.bot, p.steamId, p.ping]),
    [
      [2, "Aki", false, "STEAM_1:0:123", 24],
      [3, "Bot", true, undefined, undefined],
    ],
  );
});

test("parses status_json and ignores non-JSON replies", () => {
  assert.equal(parseStatusJson("Unknown command 'status_json'!"), undefined);
  const s = parseStatusJson(`{
    "server": { "name": "TorppaLAN", "map": "de_nuke", "max_players": 12 },
    "clients": [
      { "userid": 2, "name": "Aki", "steamid64": "76561198000000000", "bot": false, "ping": 20, "time": 754 },
      { "userid": 3, "name": "Bot Ted", "steamid64": "0", "bot": true, "ping": 0, "time": 3000 }
    ]
  }`)!;
  assert.equal(s.hostname, "TorppaLAN");
  assert.equal(s.map, "de_nuke");
  assert.equal(s.maxPlayers, 12);
  assert.deepEqual(
    s.players.map((p) => [p.id, p.name, p.bot, p.ping, p.time, p.steamId]),
    [
      [2, "Aki", false, 20, "12:34", "76561198000000000"],
      [3, "Bot Ted", true, 0, "50:00", undefined],
    ],
  );
});

// Real output from a CS2 server (wingman and casual).
const WINGMAN = `---------players--------
  id     time ping loss      state   rate adr name
   0      BOT    0    0     active      0 'Rouchard'
65535 [NoChan]    0    0 challenging      0unknown ''
   2    00:27    0    0     active 786432 10.0.0.101:59973 'A85'
#end
`;
const CASUAL = `---------players--------
  id     time ping loss      state   rate adr name
   0    02:20    0    0     active 786432 10.0.0.101:59973 'A85'
   1      BOT    0    0     active      0 'Sails'
   2      BOT    0    0     active      0 'Kadeem'
#end
`;

test("parses real CS2 player lists", () => {
  assert.deepEqual(
    parseStatusText(WINGMAN).players.map((p) => [p.id, p.name, p.bot]),
    [
      [0, "Rouchard", true],
      [2, "A85", false],
    ],
  );
  assert.deepEqual(
    parseStatusText(CASUAL).players.map((p) => [p.id, p.name, p.bot, p.time]),
    [
      [0, "A85", false, "02:20"],
      [1, "Sails", true, undefined],
      [2, "Kadeem", true, undefined],
    ],
  );
});

test("reads game mode cvars", () => {
  assert.equal(parseCvarNumber("game_mode = 1", "game_mode"), 1);
  assert.equal(parseCvarNumber('"game_type" = "0" ( def. "0" ) game replicated', "game_type"), 0);
  assert.equal(parseCvarNumber("Unknown command", "game_type"), undefined);
  assert.equal(modeName(0, 2), "Wingman");
  assert.equal(modeName(5, 9), "game_type 5 / game_mode 9");
});

test("parses ban lists", () => {
  assert.deepEqual(parseBanList("ID filter list: 2 entries\n1 STEAM_1:0:123 : permanent\n2 [U:1:999] : 30.000 min\n"), [
    { id: "STEAM_1:0:123", duration: "permanent" },
    { id: "[U:1:999]", duration: "30.000 min" },
  ]);
  assert.deepEqual(parseBanList("IP filter list:\n1 10.0.0.5 : permanent\n"), [{ id: "10.0.0.5", duration: "permanent" }]);
  assert.deepEqual(parseBanList("IP filter list: empty\n"), []);
});
