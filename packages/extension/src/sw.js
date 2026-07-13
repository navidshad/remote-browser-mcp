// MV3 service worker. Dials OUT to the VM bridge over wss://, authenticates with
// the access token, then serves browser commands via the Executor (chrome.debugger).
//
// Keepalive (the make-or-break MV3 piece): the bridge sends an app-level {t:"ping"}
// every ~20s; each inbound WS frame fires an SW event and resets MV3's ~30s idle
// timer, keeping the worker resident while the Aso window is unfocused. A 1-minute
// chrome.alarm is the revival backstop if the worker is ever evicted. All
// connection state is rebuilt on cold start; durable bits live in chrome.storage.
import { Executor } from "./executor.js";

const DEFAULT_HEARTBEAT_MS = 20000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

let socket = null;
let heartbeatTimer = null;
let backoff = 0;
let connState = "init"; // init | unconfigured | connecting | connected | auth_error | disconnected

const executor = new Executor(pushStatus);

// ── top-level registration (re-runs on every cold start) ──────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") ensureConnected();
});
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
chrome.debugger.onDetach.addListener((source, reason) => executor.onDetach(source, reason));
chrome.tabs.onRemoved.addListener((tabId) => executor.onTabRemoved(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getStatus") {
    sendResponse(statusSnapshot());
    return true;
  }
  if (msg && msg.type === "reconnect") {
    teardownSocket();
    backoff = 0;
    ensureConnected();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

ensureConnected();

// ── connection lifecycle ──────────────────────────────────────────────────────
async function ensureConnected() {
  const { agentUrl, accessToken } = await chrome.storage.local.get(["agentUrl", "accessToken"]);
  if (!agentUrl || !accessToken) {
    setConn("unconfigured");
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connect(agentUrl, accessToken);
}

function connect(url, token) {
  setConn("connecting");
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello", token, ext: "rbm-extension", v: 1, profile: "Aso Dara" }));
  };
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onerror = () => {
    /* onclose follows and handles cleanup */
  };
  ws.onclose = () => {
    if (socket === ws) {
      teardownSocket();
      if (connState !== "auth_error") setConn("disconnected");
      scheduleReconnect();
    }
  };
}

async function onMessage(data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch (e) {
    return;
  }
  switch (m.t) {
    case "welcome":
      backoff = 0;
      setConn("connected");
      startHeartbeat(m.heartbeatMs || DEFAULT_HEARTBEAT_MS);
      break;
    case "error":
      setConn("auth_error"); // bad token; bridge will close the socket
      break;
    case "ping":
      send({ t: "pong" });
      break;
    case "pong":
      break;
    case "cmd":
      handleCmd(m);
      break;
    case "session_open":
      // Lazily materialized; touch it so status reflects the new session.
      executor.getSession(m.sessionId);
      break;
    case "session_close":
      executor.closeSession(m.sessionId).finally(() => send({ t: "session_closed", sessionId: m.sessionId }));
      break;
  }
}

async function handleCmd(m) {
  try {
    const result = await executor.execute(m.name, m.args || {}, m.deadlineMs, m.sessionId);
    send({ t: "res", id: m.id, ok: true, result });
  } catch (e) {
    send({ t: "res", id: m.id, ok: false, error: { code: e.code || "error", message: String(e.message || e) } });
  }
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => send({ t: "ping" }), intervalMs);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function teardownSocket() {
  stopHeartbeat();
  if (socket) {
    try {
      socket.close();
    } catch (e) {}
  }
  socket = null;
}

function scheduleReconnect() {
  const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, backoff)) + Math.random() * 500;
  backoff = Math.min(backoff + 1, 5);
  setTimeout(ensureConnected, delay);
}

// ── status (pushed to bridge + surfaced to the popup) ─────────────────────────
function pushStatus(attached, tabId, url, reason) {
  send({
    t: "status",
    attached,
    tabId: tabId ?? null,
    url: url ?? null,
    reason,
    sessions: executor.sessionsSummary(),
  });
  chrome.storage.local.set({ lastAttached: attached, lastTabUrl: url ?? null, lastReason: reason ?? null });
}

function setConn(state) {
  connState = state;
  chrome.storage.local.set({ connState: state });
}

function statusSnapshot() {
  let tabCount = 0;
  for (const s of executor.sessions.values()) tabCount += s.tabs.size;
  return {
    connState,
    socketOpen: !!socket && socket.readyState === WebSocket.OPEN,
    sessionCount: executor.sessions.size,
    tabCount,
    debuggerAttached: executor.anyAttached(),
  };
}
