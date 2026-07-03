// Popup: edit the Agent URL + Access Token and watch the live connection state.
const $ = (id) => document.getElementById(id);

const STATE_UI = {
  init: { cls: "warn", text: "Starting…" },
  unconfigured: { cls: "warn", text: "Not configured — enter a URL and token" },
  connecting: { cls: "warn", text: "Connecting…" },
  connected: { cls: "ok", text: "Connected to agent" },
  auth_error: { cls: "err", text: "Auth failed — check the token" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
};

async function load() {
  const { agentUrl, accessToken } = await chrome.storage.local.get(["agentUrl", "accessToken"]);
  if (agentUrl) $("url").value = agentUrl;
  if (accessToken) $("token").value = accessToken;
  refresh();
}

async function refresh() {
  let snap;
  try {
    snap = await chrome.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    snap = { connState: "disconnected" };
  }
  const ui = STATE_UI[snap?.connState] || STATE_UI.disconnected;
  const dot = document.querySelector("#status .dot");
  dot.className = "dot " + ui.cls;
  let text = ui.text;
  if (snap?.connState === "connected") {
    text += snap.debuggerAttached ? " · driving a tab" : " · idle (no tab attached yet)";
  }
  $("statusText").textContent = text;
}

$("save").addEventListener("click", async () => {
  const agentUrl = $("url").value.trim();
  const accessToken = $("token").value.trim();
  await chrome.storage.local.set({ agentUrl, accessToken });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refresh, 400);
});

$("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refresh, 400);
});

load();
setInterval(refresh, 1500);
