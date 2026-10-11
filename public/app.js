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
}

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

async function runCommand(command) {
  const server = selectedServer();
  if (!server) return;
  const time = new Date().toLocaleTimeString();
  appendConsole(server.id, el("span", { className: "time", textContent: `[${time}] ` }), el("span", { className: "cmd", textContent: `> ${command}\n` }));
  try {
    const { response } = await api("POST", `/api/servers/${server.id}/command`, { command });
    appendConsole(server.id, document.createTextNode((response || "(no output)").replace(/\n?$/, "\n")));
  } catch (err) {
    appendConsole(server.id, el("span", { className: "err", textContent: `${err.message}\n` }));
  }
}

$("#add-server").addEventListener("click", () => openServerForm(null));
$("#edit-server").addEventListener("click", () => openServerForm(selectedServer()));
$("#server-form-cancel").addEventListener("click", closeServerForm);

$("#delete-server").addEventListener("click", async () => {
  const server = selectedServer();
  if (!server || !confirm(`Delete server ${server.name}?`)) return;
  await api("DELETE", `/api/servers/${server.id}`, {}).catch((e) => alert(e.message));
  consoleLogs.delete(server.id);
  await loadServers();
});

$("#server-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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
    await loadServers();
  } catch (err) {
    $("#server-form-error").textContent = err.message;
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
  runCommand(command);
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
    role.onchange = () => updateUser(u.id, { role: role.value }).catch((e) => { alert(e.message); role.value = u.role; });

    const reset = el("button", { className: "secondary", textContent: "Reset password" });
    reset.onclick = async () => {
      const password = prompt(`New password for ${u.username} (min 8 characters):`);
      if (password) await updateUser(u.id, { password }).then(() => alert("Password changed")).catch((e) => alert(e.message));
    };

    const del = el("button", { className: "danger", textContent: "Delete" });
    del.disabled = u.id === me.id;
    del.onclick = async () => {
      if (!confirm(`Delete user ${u.username}?`)) return;
      await api("DELETE", `/api/users/${u.id}`, {}).then(loadUsers).catch((e) => alert(e.message));
    };

    return el("tr", {},
      el("td", { textContent: u.username + (u.id === me.id ? " (you)" : "") }),
      el("td", {}, role),
      el("td", { textContent: new Date(u.created_at + "Z").toLocaleString() }),
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

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("POST", "/api/auth/login", formData(e.target));
    e.target.reset();
    await showMain();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("POST", "/api/auth/logout", {}).catch(() => {});
  showLogin();
});

$("#add-user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#add-user-error").textContent = "";
  try {
    await api("POST", "/api/users", formData(e.target));
    e.target.reset();
    await loadUsers();
  } catch (err) {
    $("#add-user-error").textContent = err.message;
  }
});

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#password-error").textContent = "";
  $("#password-ok").textContent = "";
  try {
    await api("POST", "/api/auth/password", formData(e.target));
    e.target.reset();
    $("#password-ok").textContent = "Password changed.";
  } catch (err) {
    $("#password-error").textContent = err.message;
  }
});

window.addEventListener("hashchange", () => me && showTab());

showMain().catch(showLogin);
