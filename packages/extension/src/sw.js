// MV3 service worker. Holds one live bridge connection PER PROFILE (each an
// Agent URL + token you can toggle on/off in the popup). Each connection dials
// its bridge over wss://, authenticates with the profile's token, and serves
// browser commands via its OWN Executor (chrome.debugger) — so tabs are isolated
// per profile.
//
// Keepalive (the make-or-break MV3 piece): each bridge sends an app-level
// {t:"ping"} every ~20s; each inbound WS frame fires an SW event and resets MV3's
// ~30s idle timer, keeping the worker resident while the Aso window is unfocused.
// A 1-minute chrome.alarm reconciles connections (revival backstop) if the worker
// is ever evicted. All connection state is rebuilt on cold start from the stored
// profile list.
import { Executor } from "./executor.js";
import { ConnectionManager } from "./connection.js";

const manager = new ConnectionManager({
  WebSocketCtor: WebSocket,
  makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
  onStateChange: () => {},
  log: (...a) => console.log(...a),
});

// ── top-level registration (re-runs on every cold start) ──────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") reconcile();
});
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);
chrome.debugger.onDetach.addListener((source, reason) => manager.onDetach(source, reason));
chrome.tabs.onRemoved.addListener((tabId) => manager.onTabRemoved(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getStatus") {
    sendResponse(manager.statusSnapshot());
    return true;
  }
  if (msg && msg.type === "saveProfiles") {
    chrome.storage.local
      .set({ profiles: msg.profiles })
      .then(() => reconcile())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "reconnect") {
    manager.reconnectAll();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

reconcile();

// ── profiles ──────────────────────────────────────────────────────────────────
/** Load the profile list, migrating the legacy single {agentUrl,accessToken}. */
async function loadProfiles() {
  const store = await chrome.storage.local.get(["profiles", "agentUrl", "accessToken"]);
  if (Array.isArray(store.profiles)) return store.profiles;
  const profiles = store.agentUrl
    ? [{ id: crypto.randomUUID(), name: "Default", agentUrl: store.agentUrl, accessToken: store.accessToken || "", enabled: true }]
    : [];
  await chrome.storage.local.set({ profiles });
  return profiles;
}

async function reconcile() {
  manager.reconcile(await loadProfiles());
}
