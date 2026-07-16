// Popup: manage multiple connection profiles (Agent URL + token), toggle each
// on/off, and watch per-profile connection state. Profiles live in
// chrome.storage.local; the service worker reconciles live connections whenever
// we save.
const $ = (id) => document.getElementById(id);

const STATE_UI = {
  init: { cls: "warn", text: "Starting…" },
  unconfigured: { cls: "warn", text: "Not configured" },
  connecting: { cls: "warn", text: "Connecting…" },
  connected: { cls: "ok", text: "Connected" },
  auth_error: { cls: "err", text: "Auth failed — check the token" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
};

let profiles = []; // local working copy
let editingId = null;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

async function load() {
  const { profiles: stored } = await chrome.storage.local.get("profiles");
  profiles = Array.isArray(stored) ? stored : [];
  render();
}

async function persist() {
  await chrome.runtime.sendMessage({ type: "saveProfiles", profiles });
  render();
}

async function getStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    return { profiles: [] };
  }
}

async function render() {
  const snap = await getStatus();
  const byId = new Map((snap?.profiles || []).map((p) => [p.id, p]));
  const list = $("profiles");
  list.textContent = "";

  if (profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No profiles yet. Add one to connect a bridge.";
    list.appendChild(empty);
    return;
  }

  for (const p of profiles) {
    const st = byId.get(p.id);
    const ui = p.enabled ? STATE_UI[st?.connState] || STATE_UI.connecting : { cls: "", text: "Off" };

    const row = document.createElement("div");
    row.className = "profile";

    const top = document.createElement("div");
    top.className = "top";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = (p.blockInput ? "🔒 " : "") + (p.name || "(unnamed)");
    top.appendChild(name);

    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!p.enabled;
    cb.addEventListener("change", () => toggle(p.id, cb.checked));
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);
    top.appendChild(sw);
    row.appendChild(top);

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = p.agentUrl || "(no url)";
    row.appendChild(url);

    const state = document.createElement("div");
    state.className = "state";
    let stateText = "";
    if (ui.cls) stateText = `<span class="dot ${ui.cls}"></span>`;
    state.innerHTML = stateText;
    const label = document.createElement("span");
    let txt = ui.text;
    if (p.enabled && st?.connState === "connected") {
      txt += st.tabCount ? ` · ${st.tabCount} tab${st.tabCount === 1 ? "" : "s"}` : " · idle";
    }
    label.textContent = txt;
    state.appendChild(label);
    row.appendChild(state);

    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = document.createElement("button");
    edit.className = "ghost";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(p.id));
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "Delete";
    del.addEventListener("click", () => remove(p.id));
    actions.appendChild(edit);
    actions.appendChild(del);
    row.appendChild(actions);

    list.appendChild(row);
  }
}

function toggle(id, enabled) {
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  p.enabled = enabled;
  persist();
}

function remove(id) {
  profiles = profiles.filter((x) => x.id !== id);
  if (editingId === id) closeForm();
  persist();
}

// ── add / edit form ────────────────────────────────────────────────────────────
function openForm(id) {
  editingId = id ?? null;
  const p = id ? profiles.find((x) => x.id === id) : null;
  $("formTitle").textContent = p ? "Edit profile" : "New profile";
  $("name").value = p?.name ?? "";
  $("url").value = p?.agentUrl ?? "";
  $("token").value = p?.accessToken ?? "";
  $("blockInput").checked = !!p?.blockInput;
  $("form").classList.remove("hidden");
}

function closeForm() {
  editingId = null;
  $("form").classList.add("hidden");
}

function saveForm() {
  const name = $("name").value.trim();
  const agentUrl = $("url").value.trim();
  const accessToken = $("token").value.trim();
  const blockInput = $("blockInput").checked;
  if (!agentUrl) {
    $("url").focus();
    return;
  }
  if (editingId) {
    const p = profiles.find((x) => x.id === editingId);
    if (p) Object.assign(p, { name, agentUrl, accessToken, blockInput });
  } else {
    profiles.push({ id: uuid(), name: name || "Bridge", agentUrl, accessToken, enabled: true, blockInput });
  }
  closeForm();
  persist();
}

$("add").addEventListener("click", () => openForm(null));
$("cancel").addEventListener("click", closeForm);
$("saveProfile").addEventListener("click", saveForm);
$("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(render, 400);
});

load();
setInterval(render, 1500);
