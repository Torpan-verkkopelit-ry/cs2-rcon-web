"use strict";

const $ = (sel) => document.querySelector(sel);
let me = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/auth/login" && url !== "/api/auth/password") {
    showLogin();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// --- feedback ---

/**
 * Shows a spinner on the button and disables it while fn runs, then flashes
 * green or red. fn returns false when the user cancelled (no flash).
 * Returns fn's result and rethrows its error.
 */
async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const result = await fn();
    if (result !== false) flash(btn, "ok");
    return result;
  } catch (err) {
    flash(btn, "fail");
    throw err;
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

function flash(btn, kind) {
  btn.classList.remove("flash-ok", "flash-fail");
  void btn.offsetWidth; // restart the animation
  btn.classList.add(`flash-${kind}`);
  setTimeout(() => btn.classList.remove(`flash-${kind}`), 1200);
}

/** Click handler with busy state; errors are already shown by fn or toasted here. */
function onBusyClick(btn, fn) {
  btn.addEventListener("click", (e) => withBusy(btn, () => fn(e)).catch(() => {}));
}

/** Submit handler with busy state on the form's submit button. */
function onBusySubmit(form, fn) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = e.submitter || form.querySelector('button[type="submit"]');
    withBusy(btn, () => fn(e)).catch(() => {});
  });
}

function toast(message, kind = "ok") {
  const node = el("div", { className: `toast ${kind}`, textContent: message, role: kind === "fail" ? "alert" : "status" });
  node.onclick = () => node.remove();
  $("#toasts").append(node);
  while ($("#toasts").children.length > 4) $("#toasts").firstElementChild.remove();
  setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 300);
  }, kind === "fail" ? 6000 : 2500);
}

/** Runs fn and toasts the outcome; rethrows so withBusy can flash red. */
async function reported(okMessage, fn) {
  try {
    const result = await fn();
    if (okMessage) toast(okMessage, "ok");
    return result;
  } catch (err) {
    toast(err.message, "fail");
    throw err;
  }
}

// --- views ---

function showLogin() {
  me = null;
  $("#main-view").hidden = true;
  $("#login-view").hidden = false;
}

async function showMain() {
  me = (await api("GET", "/api/auth/me")).user;
  $("#login-view").hidden = true;
  $("#main-view").hidden = false;
  $("#whoami").textContent = `${me.username} (${me.role})`;
  $("#users-link").hidden = me.role !== "admin";
  document.querySelectorAll(".admin-only").forEach((n) => (n.hidden = me.role !== "admin"));
  showTab();
}

function showTab() {
  let tab = location.hash.slice(1) || "servers";
  if (tab === "users" && me?.role !== "admin") tab = "servers";
  if (!document.getElementById(`tab-${tab}`)) tab = "servers";
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  document.querySelectorAll("header nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "users") loadUsers();
  if (tab === "servers") loadServers();
  if (tab === "log") loadLog();
  if (tab === "bans") showBans();
  if (tab === "messages") showMessages();
}

// --- servers ---

let servers = [];
let selectedId = null;
try { selectedId = Number(localStorage.getItem("selectedServer")) || null; } catch {}
let editingId = null;
const consoleLogs = new Map(); // server id -> array of console nodes, kept while switching servers
const cmdHistory = [];
let historyPos = 0;

const selectedServer = () => servers.find((s) => s.id === selectedId);

async function loadServers() {
  servers = (await api("GET", "/api/servers")).servers;
  if (!selectedServer()) selectedId = servers[0]?.id ?? null;
  renderServers();
}

function renderServers() {
  $("#no-servers").hidden = servers.length > 0;
  $("#server-list").replaceChildren(
    ...servers.map((s) => {
      const li = el("li", { className: s.id === selectedId ? "active" : "" }, s.name, el("small", { textContent: `${s.host}:${s.port}` }));
      li.onclick = () => selectServer(s.id);
      return li;
    }),
  );
  const server = selectedServer();
  $("#server-panel").hidden = !server || !$("#server-form").hidden;
  $("#server-empty").hidden = !!server || servers.length === 0 || !$("#server-form").hidden;
  if (!server) return;
  $("#server-name").textContent = server.name;
  $("#server-address").textContent = `${server.host}:${server.port}`;
  $("#console-output").replaceChildren(...(consoleLogs.get(server.id) || []));
  scrollConsole();
  if (shownServerId !== server.id) {
    shownServerId = server.id;
    $("#players-error").textContent = "";
    renderPlayers(lastStatus.get(server.id));
    renderMapOptions();
    resetMapForm();
    if (!serverMaps.has(server.id)) loadServerMaps(server.id).catch(() => {});
    renderConfigList();
    refreshPlayers();
  }
}

let shownServerId = null;

function selectServer(id) {
  selectedId = id;
  try { localStorage.setItem("selectedServer", String(id)); } catch {}
  closeServerForm();
  renderServers();
  $("#console-form input").focus();
}

function openServerForm(server) {
  editingId = server?.id ?? null;
  const form = $("#server-form");
  form.reset();
  $("#server-form-title").textContent = server ? `Edit ${server.name}` : "Add server";
  $("#server-form-hint").hidden = !server;
  form.rconPassword.required = !server;
  if (server) {
    form.name.value = server.name;
    form.host.value = server.host;
    form.port.value = server.port;
  }
  $("#server-form-error").textContent = "";
  form.hidden = false;
  renderServers();
  form.name.focus();
}

function closeServerForm() {
  $("#server-form").hidden = true;
  editingId = null;
  renderServers();
}

function appendConsole(serverId, ...nodes) {
  const lines = consoleLogs.get(serverId) || [];
  lines.push(...nodes);
  if (lines.length > 600) lines.splice(0, lines.length - 600);
  consoleLogs.set(serverId, lines);
  if (serverId === selectedId) {
    $("#console-output").append(...nodes);
    scrollConsole();
  }
}

function scrollConsole() {
  const out = $("#console-output");
  out.scrollTop = out.scrollHeight;
}

async function runCommand(command, serverId = selectedId) {
  const server = servers.find((s) => s.id === serverId);
  if (!server) return;
  const time = new Date().toLocaleTimeString();
  appendConsole(server.id, el("span", { className: "time", textContent: `[${time}] ` }), el("span", { className: "cmd", textContent: `> ${command}\n` }));
  try {
    const { response } = await api("POST", `/api/servers/${server.id}/command`, { command });
    appendConsole(server.id, document.createTextNode((response || "(no output)").replace(/\n?$/, "\n")));
    return response;
  } catch (err) {
    appendConsole(server.id, el("span", { className: "err", textContent: `${err.message}\n` }));
    throw err;
  }
}

/** Runs commands one after another, stopping at the first failure. */
async function runCommands(commands, serverId = selectedId) {
  for (const c of commands) await runCommand(c, serverId);
}

// --- quick controls ---

const quoteArg = (s) => `"${s.replace(/"/g, "")}"`;

function configsKey(id) {
  return `configs:${id}`;
}

function savedConfigs(id) {
  try { return JSON.parse(localStorage.getItem(configsKey(id)) || "[]"); } catch { return []; }
}

function renderConfigList() {
  $("#config-list").replaceChildren(...savedConfigs(selectedId).map((c) => el("option", { value: c })));
}

// The map/mode pickers follow the server's current map and mode until someone changes them.
let mapFormDirty = false;

function syncMapForm(status) {
  if (mapFormDirty) return;
  const select = $("#map-select");
  const map = status?.map;
  // Workshop maps are listed by name but their option value is the Workshop ID.
  let option = map && [...select.options].find((o) => o.value === map || o.textContent === map);
  if (map && !option) {
    option = el("option", { value: map, textContent: map });
    select.insertBefore(option, select.querySelector('option[value="__other"]'));
  }
  if (option) select.value = option.value;
  $("#map-other").hidden = select.value !== "__other";
  const mode = $("#mode-select");
  const current = status?.gameType !== undefined && status?.gameMode !== undefined ? `${status.gameType},${status.gameMode}` : "";
  mode.value = [...mode.options].some((o) => o.value === current) ? current : "";
}

// Map picker options: the server's map group once loaded, else the built-in list.
const builtInMaps = [...$("#map-select").options].filter((o) => o.value !== "__other").map((o) => ({ name: o.textContent, value: o.value }));
const serverMaps = new Map(); // server id -> maps from print_mapgroup_sv (empty: none found)

function renderMapOptions() {
  const select = $("#map-select");
  const current = select.value;
  const maps = serverMaps.get(selectedId)?.length ? serverMaps.get(selectedId) : builtInMaps;
  select.replaceChildren(
    ...maps.map((m) => el("option", { value: m.value, textContent: m.name })),
    el("option", { value: "__other", textContent: "Other / Workshop…" }),
  );
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  syncMapForm(lastStatus.get(selectedId));
}

/** Loads the server's map group into the picker. Returns the parsed group. */
async function loadServerMaps(serverId) {
  const group = await api("GET", `/api/servers/${serverId}/maps`);
  serverMaps.set(serverId, group.maps);
  if (serverId === selectedId) renderMapOptions();
  return group;
}

onBusyClick($("#maps-reload"), async () => {
  const serverId = selectedId;
  let group;
  try {
    group = await loadServerMaps(serverId);
  } catch (err) {
    toast(err.message, "fail");
    throw err;
  }
  if (!group.maps.length) {
    toast("The server listed no maps; showing the built-in list.", "fail");
    throw new Error("no maps");
  }
  toast(`Loaded ${group.maps.length} map${group.maps.length === 1 ? "" : "s"}${group.name ? ` from ${group.name}` : ""}`);
});

function resetMapForm() {
  mapFormDirty = false;
  $("#map-other").value = "";
  syncMapForm(lastStatus.get(selectedId));
}

$("#map-select").addEventListener("change", () => {
  mapFormDirty = true;
  const other = $("#map-select").value === "__other";
  $("#map-other").hidden = !other;
  if (other) $("#map-other").focus();
});
$("#map-other").addEventListener("input", () => (mapFormDirty = true));
$("#mode-select").addEventListener("change", () => (mapFormDirty = true));

onBusySubmit($("#map-form"), async () => {
  const serverId = selectedId;
  const map = ($("#map-select").value === "__other" ? $("#map-other").value : $("#map-select").value).trim();
  const mode = $("#mode-select").value;
  if (!map) {
    toast("Enter a map name or Workshop ID.", "fail");
    $("#map-other").focus();
    throw new Error("no map");
  }
  const commands = [];
  if (mode) {
    const [type, gameMode] = mode.split(",");
    commands.push(`game_type ${type}`, `game_mode ${gameMode}`);
  }
  commands.push(/^\d+$/.test(map) ? `host_workshop_map ${map}` : `map ${map}`);
  await reported(`Changing map to ${map}`, () => runCommands(commands, serverId));
  if (serverId === selectedId) resetMapForm();
  setTimeout(() => serverId === selectedId && refreshPlayers(), 5000);
});

onBusySubmit($("#config-form"), async () => {
  const serverId = selectedId;
  const name = $("#config-input").value.trim();
  if (!name) return false;
  await reported(`Ran ${name}`, () => runCommand(`exec ${name}`, serverId));
  const list = [name, ...savedConfigs(serverId).filter((c) => c !== name)].slice(0, 20);
  try { localStorage.setItem(configsKey(serverId), JSON.stringify(list)); } catch {}
  renderConfigList();
  $("#config-input").value = "";
});

document.querySelectorAll(".quick-buttons button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
    withBusy(btn, () => reported(`${btn.textContent}: done`, () => runCommand(btn.dataset.cmd))).catch(() => {});
  });
});

// mp_warmup_pausetimer 1 keeps warmup running until it is ended. It stays set on the
// server, so timed starts and End warmup turn it off again.
try { $("#warmup-time").value = localStorage.getItem("warmupTime") || $("#warmup-time").value; } catch {}

/** Runs one warmup action at a time so two clicks can't mix their commands. */
async function warmupAction(okMessage, commands) {
  const others = [...document.querySelectorAll("#warmup-form button:not(.busy)")];
  others.forEach((b) => (b.disabled = true));
  try {
    await reported(okMessage, () => runCommands(commands));
  } finally {
    others.forEach((b) => (b.disabled = false));
  }
}

onBusySubmit($("#warmup-form"), () => {
  const seconds = Number($("#warmup-time").value);
  try { localStorage.setItem("warmupTime", String(seconds)); } catch {}
  return warmupAction(`Warmup started (${seconds}s)`, ["mp_warmup_pausetimer 0", `mp_warmuptime ${seconds}`, "mp_warmup_start"]);
});

onBusyClick($("#warmup-indefinite"), () =>
  warmupAction("Warmup started until ended", ["mp_warmup_pausetimer 1", "mp_warmup_start"]));

onBusyClick($("#warmup-end"), () => warmupAction("Warmup ended", ["mp_warmup_pausetimer 0", "mp_warmup_end"]));

onBusySubmit($("#restart-form"), async () => {
  const seconds = Number($("#restart-time").value);
  if (!confirm(`Restart the game in ${seconds}s? Scores are reset.`)) return false;
  await reported(`Game restarts in ${seconds}s`, () => runCommand(`mp_restartgame ${seconds}`));
});

// --- players ---

const lastStatus = new Map(); // server id -> last status from the server
let playersLoading = false;

/** Returns false when the status request failed (the error is shown under the table). */
async function refreshPlayers() {
  const serverId = selectedId;
  if (!serverId || playersLoading) return true;
  playersLoading = true;
  try {
    const status = await api("GET", `/api/servers/${serverId}/status`);
    lastStatus.set(serverId, status);
    if (serverId === selectedId) {
      $("#players-error").textContent = "";
      renderPlayers(status);
      syncMapForm(status);
    }
    return true;
  } catch (err) {
    if (serverId === selectedId) $("#players-error").textContent = err.message;
    return false;
  } finally {
    playersLoading = false;
  }
}

function renderPlayers(status) {
  const players = status?.players || [];
  const humans = players.filter((p) => !p.bot).length;
  const bots = players.length - humans;
  const parts = [];
  if (status?.map) parts.push(status.map);
  if (status?.modeName) parts.push(status.modeName);
  if (status) parts.push(`${humans} player${humans === 1 ? "" : "s"}${bots ? ` + ${bots} bot${bots === 1 ? "" : "s"}` : ""}${status.maxPlayers ? ` / ${status.maxPlayers}` : ""}`);
  $("#players-summary").textContent = parts.length ? `· ${parts.join(" · ")}` : "";
  $("#players-empty").hidden = !status || players.length > 0;
  $("#player-rows").replaceChildren(
    ...players.map((p) => {
      const name = el("td", { textContent: p.name });
      if (p.bot) name.append(el("span", { className: "bot-tag", textContent: "BOT" }));
      const kick = el("button", { className: "danger", textContent: "Kick" });
      kick.onclick = async () => {
        if (!confirm(`Kick ${p.name}?`)) return;
        const command = p.id !== undefined && p.id !== null ? `kickid ${p.id}` : `kick ${quoteArg(p.name)}`;
        await withBusy(kick, () => reported(`Kicked ${p.name}`, () => runCommand(command))).catch(() => {});
        refreshPlayers();
      };
      return el("tr", {},
        name,
        el("td", { className: "mono", textContent: p.address ? p.address.replace(/:\d+$/, "") : "", title: p.address || "" }),
        el("td", { className: "mono", textContent: p.bot || p.ping === undefined ? "" : String(p.ping) }),
        el("td", { className: "mono hide-sm", textContent: p.time || "" }),
        el("td", { className: "actions" }, kick),
      );
    }),
  );
}

onBusyClick($("#players-refresh"), async () => {
  if (!(await refreshPlayers())) throw new Error("refresh failed");
});

setInterval(() => {
  if (!me || $("#tab-servers").hidden || $("#server-panel").hidden) return;
  if (!$("#players-auto").checked || document.visibilityState !== "visible") return;
  refreshPlayers();
}, 10000);

// --- messages ---

const sentMessages = []; // { time, server, text }, newest first, kept until the page reloads

/** Opens the Messages tab on the selected server. */
function showMessages() {
  const fill = () => {
    const select = $("#messages-server");
    select.replaceChildren(...servers.map((s) => el("option", { value: String(s.id), textContent: s.name })));
    const id = selectedServer()?.id ?? servers[0]?.id ?? null;
    select.value = id ? String(id) : "";
    const none = servers.length === 0;
    $("#messages-no-servers").hidden = !none;
    select.hidden = none;
    $("#message-form").hidden = none;
    renderSentMessages();
    if (!none) $("#message-input").focus();
  };
  if (servers.length) fill();
  else api("GET", "/api/servers").then((r) => { servers = r.servers; fill(); }).catch(() => {});
}

$("#messages-server").addEventListener("change", () => {
  selectedId = Number($("#messages-server").value);
  try { localStorage.setItem("selectedServer", String(selectedId)); } catch {}
});

function renderSentMessages() {
  $("#sent-messages").replaceChildren(
    ...sentMessages.map((m) => {
      const li = el("li", { title: "Reuse this message" },
        el("span", { className: "meta", textContent: `${m.time} · ${m.server}` }),
        el("span", { textContent: m.text }));
      li.onclick = () => {
        $("#message-input").value = m.text;
        $("#message-input").focus();
      };
      return li;
    }),
  );
}

onBusySubmit($("#message-form"), async () => {
  const server = servers.find((s) => s.id === Number($("#messages-server").value));
  // Quotes keep a ; in the message from starting a new console command, so quotes are dropped.
  const text = $("#message-input").value.replace(/"/g, "").replace(/\s+/g, " ").trim();
  if (!server || !text) return false;
  await reported(`Sent to ${server.name}`, () => runCommand(`say ${quoteArg(text)}`, server.id));
  sentMessages.unshift({ time: new Date().toLocaleTimeString(), server: server.name, text });
  if (sentMessages.length > 50) sentMessages.pop();
  renderSentMessages();
  $("#message-input").value = "";
  $("#message-input").focus();
});

// --- bans ---

let bansServerId = null; // server whose bans are on screen

/** Opens the Bans tab on the selected server and loads its ban list. */
function showBans() {
  const select = $("#bans-server");
  const fill = () => {
    select.replaceChildren(...servers.map((s) => el("option", { value: String(s.id), textContent: s.name })));
    const id = selectedServer()?.id ?? servers[0]?.id ?? null;
    select.value = id ? String(id) : "";
    const none = servers.length === 0;
    $("#bans-no-servers").hidden = !none;
    select.hidden = none;
    $("#bans-load").disabled = none;
    document.querySelector("#tab-bans .bans-grid").hidden = none;
    return id;
  };
  const load = () => {
    const id = fill();
    if (id !== bansServerId) renderBans(null);
    if (id) withBusy($("#bans-load"), loadBans).catch(() => {});
  };
  if (servers.length) load();
  else api("GET", "/api/servers").then((r) => { servers = r.servers; load(); }).catch(() => {});
}

$("#bans-server").addEventListener("change", () => {
  selectedId = Number($("#bans-server").value);
  try { localStorage.setItem("selectedServer", String(selectedId)); } catch {}
  renderBans(null);
  withBusy($("#bans-load"), loadBans).catch(() => {});
});

function renderBans(bans) {
  $("#bans-error").textContent = "";
  const rows = (list, kind) => {
    if (!bans) return [el("tr", {}, el("td", { className: "muted small", textContent: "Loading…" }))];
    if (!list.length) return [el("tr", {}, el("td", { className: "muted small", textContent: "None" }))];
    return list.map((b) => {
      const unban = el("button", { className: "secondary", textContent: "Unban" });
      unban.onclick = () => withBusy(unban, () => unbanEntry(kind, b.id)).catch(() => {});
      return el("tr", {}, el("td", { className: "mono", textContent: b.id }), el("td", { className: "muted small", textContent: b.duration }), el("td", { className: "actions" }, unban));
    });
  };
  $("#ban-id-rows").replaceChildren(...rows(bans?.steamIds, "id"));
  $("#ban-ip-rows").replaceChildren(...rows(bans?.ips, "ip"));
}

async function loadBans() {
  const serverId = selectedId;
  if (!serverId) return;
  try {
    const bans = await api("GET", `/api/servers/${serverId}/bans`);
    if (serverId === selectedId) {
      bansServerId = serverId;
      renderBans(bans);
    }
  } catch (err) {
    if (serverId === selectedId) $("#bans-error").textContent = err.message;
    throw err;
  }
}

/** Returns false when the user cancelled. */
async function unbanEntry(kind, value) {
  value = value.trim().replace(/[";\s]/g, "");
  if (!value || !confirm(`Unban ${value}?`)) return false;
  // write* saves the ban list so the unban survives a server restart.
  const commands = kind === "ip" ? [`removeip ${value}`, "writeip"] : [`removeid ${value}`, "writeid"];
  await reported(`Unbanned ${value}`, () => runCommands(commands));
  await loadBans().catch(() => {});
  return true;
}

onBusyClick($("#bans-load"), loadBans);
document.querySelectorAll(".unban-form").forEach((form) => {
  onBusySubmit(form, async () => {
    const input = form.querySelector("input");
    if (!(await unbanEntry(form.dataset.kind, input.value))) return false;
    input.value = "";
  });
});

// --- command log ---

async function loadLog() {
  const select = $("#log-server");
  const current = select.value;
  if (!servers.length) servers = (await api("GET", "/api/servers")).servers;
  select.replaceChildren(el("option", { value: "", textContent: "All servers" }), ...servers.map((s) => el("option", { value: String(s.id), textContent: s.name })));
  select.value = current;
  const { entries } = await api("GET", `/api/log${select.value ? `?serverId=${select.value}` : ""}`);
  $("#log-empty").hidden = entries.length > 0;
  $("#log-rows").replaceChildren(
    ...entries.map((e) =>
      el("tr", {},
        el("td", { className: "mono", textContent: new Date(e.at + "Z").toLocaleString() }),
        el("td", { textContent: e.username }),
        el("td", { textContent: e.server_name }),
        el("td", { className: "mono", textContent: e.command }),
        el("td", { className: e.ok ? "muted" : "fail", textContent: e.ok ? "ok" : "failed" }),
      ),
    ),
  );
}

$("#log-server").addEventListener("change", loadLog);
onBusyClick($("#log-refresh"), loadLog);

$("#add-server").addEventListener("click", () => openServerForm(null));
$("#edit-server").addEventListener("click", () => openServerForm(selectedServer()));
$("#server-form-cancel").addEventListener("click", closeServerForm);

onBusyClick($("#delete-server"), async () => {
  const server = selectedServer();
  if (!server || !confirm(`Delete server ${server.name}?`)) return false;
  await reported(`Deleted ${server.name}`, () => api("DELETE", `/api/servers/${server.id}`, {}));
  consoleLogs.delete(server.id);
  await loadServers();
});

onBusySubmit($("#server-form"), async (e) => {
  const data = formData(e.target);
  data.port = Number(data.port);
  $("#server-form-error").textContent = "";
  try {
    if (editingId) {
      await api("PUT", `/api/servers/${editingId}`, data);
    } else {
      selectedId = (await api("POST", "/api/servers", data)).id;
    }
    $("#server-form").hidden = true;
    editingId = null;
    toast(`Saved ${data.name}`);
    await loadServers();
  } catch (err) {
    $("#server-form-error").textContent = err.message;
    throw err;
  }
});

$("#console-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = e.target.command;
  const command = input.value.trim();
  if (!command) return;
  if (cmdHistory[cmdHistory.length - 1] !== command) cmdHistory.push(command);
  historyPos = cmdHistory.length;
  input.value = "";
  runCommand(command).catch(() => {});
});

$("#console-form input").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  historyPos = Math.max(0, Math.min(cmdHistory.length, historyPos + (e.key === "ArrowUp" ? -1 : 1)));
  e.target.value = cmdHistory[historyPos] ?? "";
});

$("#console-clear").addEventListener("click", () => {
  consoleLogs.delete(selectedId);
  $("#console-output").replaceChildren();
});

// --- users ---

async function loadUsers() {
  const { users } = await api("GET", "/api/users");
  const rows = users.map((u) => {
    const role = el("select", {}, el("option", { value: "operator", textContent: "Operator" }), el("option", { value: "admin", textContent: "Admin" }));
    role.value = u.role;
    role.onchange = () => reported(`${u.username} is now ${role.value}`, () => updateUser(u.id, { role: role.value })).catch(() => { role.value = u.role; });

    const reset = el("button", { className: "secondary", textContent: "Reset password" });
    reset.onclick = async () => {
      const password = prompt(`New password for ${u.username} (min 8 characters):`);
      if (password) await withBusy(reset, () => reported(`Password changed for ${u.username}`, () => updateUser(u.id, { password }))).catch(() => {});
    };

    const del = el("button", { className: "danger", textContent: "Delete" });
    del.disabled = u.id === me.id;
    del.onclick = async () => {
      if (!confirm(`Delete user ${u.username}?`)) return;
      await withBusy(del, () => reported(`Deleted ${u.username}`, () => api("DELETE", `/api/users/${u.id}`, {}))).then(loadUsers).catch(() => {});
    };

    return el("tr", {},
      el("td", { textContent: u.username + (u.id === me.id ? " (you)" : "") }),
      el("td", {}, role),
      el("td", { className: "hide-sm", textContent: new Date(u.created_at + "Z").toLocaleString() }),
      el("td", { className: "actions" }, reset, " ", del),
    );
  });
  $("#user-rows").replaceChildren(...rows);
}

async function updateUser(id, changes) {
  await api("PATCH", `/api/users/${id}`, changes);
  if (id === me.id && changes.role) return showMain();
  await loadUsers();
}

// --- events ---

onBusySubmit($("#login-form"), async (e) => {
  $("#login-error").textContent = "";
  try {
    await api("POST", "/api/auth/login", formData(e.target));
    e.target.reset();
    await showMain();
  } catch (err) {
    $("#login-error").textContent = err.message;
    throw err;
  }
});

onBusyClick($("#logout"), async () => {
  await api("POST", "/api/auth/logout", {}).catch(() => {});
  showLogin();
  return false;
});

onBusySubmit($("#add-user-form"), async (e) => {
  $("#add-user-error").textContent = "";
  try {
    const { username } = formData(e.target);
    await api("POST", "/api/users", formData(e.target));
    e.target.reset();
    toast(`Added ${username}`);
    await loadUsers();
  } catch (err) {
    $("#add-user-error").textContent = err.message;
    throw err;
  }
});

onBusySubmit($("#password-form"), async (e) => {
  $("#password-error").textContent = "";
  $("#password-ok").textContent = "";
  try {
    await api("POST", "/api/auth/password", formData(e.target));
    e.target.reset();
    $("#password-ok").textContent = "Password changed.";
  } catch (err) {
    $("#password-error").textContent = err.message;
    throw err;
  }
});

window.addEventListener("hashchange", () => me && showTab());

showMain().catch(showLogin);
