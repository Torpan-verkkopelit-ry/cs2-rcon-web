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
  showTab();
}

function showTab() {
  let tab = location.hash.slice(1) || "servers";
  if (tab === "users" && me?.role !== "admin") tab = "servers";
  if (!document.getElementById(`tab-${tab}`)) tab = "servers";
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  document.querySelectorAll("header nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "users") loadUsers();
}

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
