// Automated multi-PROFILE test harness — no Chrome required.
//
// Proves the extension can hold multiple live bridge connections at once, with
// per-profile tab isolation and an on/off toggle. Wiring:
//   • two REAL bridge-servers (different tokens) = two bridges
//   • a REAL ConnectionManager (from packages/extension/src/connection.js) with
//     an injected `ws` WebSocket + the REAL Executor, over a mocked chrome.* API
//   • REAL MCP clients driving each bridge
//
// Asserts: both profiles connect; a tab opened via bridge X is owned by profile
// X's Executor and invisible to profile Y's (profile isolation); nested session
// isolation still holds on a single bridge; disabling profile Y tears down only
// its connection while its tab stays open; re-enabling reconnects.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket as WsWebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// connection.js reads the `WebSocket.OPEN`/`CONNECTING` constants off the global;
// point them (and the injected ctor) at `ws` so semantics match in Node.
globalThis.WebSocket = WsWebSocket;

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};
const firstText = (r) => (r?.content ?? []).find((p) => p.type === "text")?.text ?? "";
const isErr = (r) => !!r?.isError;
const tabTotal = (ex) => [...ex.sessions.values()].reduce((n, s) => n + s.tabs.size, 0);

// ── mock chrome.* (shared tab store; each Executor tracks only its own tabs) ───
let nextTabId = 100;
const tabs = new Map();
function makeTab(url) {
  const id = ++nextTabId;
  for (const t of tabs.values()) t.active = false;
  const tab = { id, url: url || "about:blank", title: url || "about:blank", active: true };
  tabs.set(id, tab);
  return tab;
}
globalThis.chrome = {
  runtime: { lastError: undefined },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  tabs: {
    get: (id) => (tabs.has(id) ? Promise.resolve({ ...tabs.get(id) }) : Promise.reject(new Error("no tab"))),
    query: () => Promise.resolve([...tabs.values()].map((t) => ({ ...t }))),
    create: ({ url }) => Promise.resolve(makeTab(url)),
    remove: (id) => (tabs.delete(id), Promise.resolve()),
    update: (id, props) => {
      const t = tabs.get(id);
      if (t && props.active) {
        for (const x of tabs.values()) x.active = false;
        t.active = true;
      }
      return Promise.resolve(t);
    },
  },
  debugger: {
    attach: (_t, _v, cb) => cb(),
    detach: (_t, cb) => cb(),
    sendCommand: ({ tabId }, method, params, cb) => {
      const t = tabs.get(tabId);
      if (method === "Page.navigate") {
        if (t) t.url = t.title = params.url;
        return cb({});
      }
      if (method === "Runtime.evaluate") {
        const value = params.expression.includes("document.readyState") ? "complete" : `SNAPSHOT[${t ? t.url : "?"}]`;
        return cb({ result: { value } });
      }
      if (method === "Page.captureScreenshot") return cb({ data: "AAAA" });
      return cb({});
    },
  },
};

const { Executor } = await import("../packages/extension/src/executor.js");
const { ConnectionManager } = await import("../packages/extension/src/connection.js");

async function startBridge({ mcpPort, wsPort, token }) {
  const proc = spawn("node", ["packages/bridge-server/dist/index.js"], {
    env: { ...process.env, BRIDGE_ACCESS_TOKEN: token, MCP_PORT: String(mcpPort), WS_PORT: String(wsPort), SESSION_IDLE_MS: String(30 * 60_000) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[bridge:${wsPort}:err] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${mcpPort}/health`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error(`bridge ${wsPort} did not become healthy`);
}

const newClient = async (name, mcpPort) => {
  const c = new Client({ name, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${mcpPort}/mcp`));
  await c.connect(transport);
  return { client: c, transport };
};

async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  const X = { mcpPort: 3920, wsPort: 3922, token: "token-X" };
  const Y = { mcpPort: 3930, wsPort: 3932, token: "token-Y" };
  const bridgeX = await startBridge(X);
  const bridgeY = await startBridge(Y);

  const manager = new ConnectionManager({
    WebSocketCtor: WsWebSocket,
    makeExecutor: (pushStatus) => new Executor(pushStatus),
    log: () => {},
  });

  const pX = { id: "prof-X", name: "X", agentUrl: `ws://localhost:${X.wsPort}`, accessToken: X.token, enabled: true };
  const pY = { id: "prof-Y", name: "Y", agentUrl: `ws://localhost:${Y.wsPort}`, accessToken: Y.token, enabled: true };
  manager.reconcile([pX, pY]);

  const connX = () => manager.connections.get("prof-X");
  const connY = () => manager.connections.get("prof-Y");

  const bothUp = await waitFor(() => connX()?.connState === "connected" && connY()?.connState === "connected");
  bothUp ? pass("both profiles reached 'connected' simultaneously") : fail(`profiles not both connected: X=${connX()?.connState} Y=${connY()?.connState}`);

  console.log("");
  const { client: ax } = await newClient("agent-on-X", X.mcpPort);
  const { client: ay } = await newClient("agent-on-Y", Y.mcpPort);

  const hx = firstText(await ax.callTool({ name: "browser_tab_new", arguments: { url: "https://x.example/" } })).match(/\bt\d+\b/)?.[0];
  const hy = firstText(await ay.callTool({ name: "browser_tab_new", arguments: { url: "https://y.example/" } })).match(/\bt\d+\b/)?.[0];
  hx && hy ? pass(`each profile opened a tab (X:${hx}, Y:${hy})`) : fail(`tab open failed: X=${hx} Y=${hy}`);

  // profile isolation: X's Executor owns exactly its tab; Y's owns exactly its own
  tabTotal(connX().executor) === 1 && tabTotal(connY().executor) === 1
    ? pass("each profile's Executor owns only its own tab")
    : fail(`ownership wrong: X=${tabTotal(connX().executor)} Y=${tabTotal(connY().executor)}`);

  const xIds = new Set(connX().executor.tabIndex.keys());
  const yIds = [...connY().executor.tabIndex.keys()];
  yIds.every((id) => !xIds.has(id))
    ? pass("profiles X and Y hold disjoint chrome tabs (no cross-profile visibility)")
    : fail("profile tab sets overlap — isolation breach");

  // nested session isolation still holds within one bridge
  const { client: ax2 } = await newClient("agent2-on-X", X.mcpPort);
  const listX2 = firstText(await ax2.callTool({ name: "browser_tab_list", arguments: {} }));
  const crossX = await ax2.callTool({ name: "browser_snapshot", arguments: { tab: hx } });
  !listX2.includes("x.example") && isErr(crossX) && /not owned/i.test(firstText(crossX))
    ? pass("nested session isolation intact on bridge X (2nd agent can't see 1st's tab)")
    : fail(`nested session isolation broke: list='${listX2}' cross='${firstText(crossX)}'`);

  // ── toggle profile Y OFF: only Y tears down; its tab stays open ──────────────
  console.log("");
  const yTabId = [...connY().executor.tabIndex.keys()][0];
  manager.reconcile([pX, { ...pY, enabled: false }]);
  const yGone = await waitFor(() => !manager.connections.has("prof-Y"));
  yGone && manager.connections.has("prof-X") ? pass("disabling Y tore down only Y's connection (X still live)") : fail("toggle-off did not isolate to Y");
  tabs.has(yTabId) ? pass("Y's tab stayed open after disable (detach, don't close)") : fail("Y's tab was closed on disable");

  // X still fully functional after Y toggled off
  const hx2 = firstText(await ax.callTool({ name: "browser_tab_new", arguments: { url: "https://x.example/2" } })).match(/\bt\d+\b/)?.[0];
  hx2 && connX()?.connState === "connected" ? pass("profile X keeps working after Y is disabled") : fail(`X broke after Y disable: ${connX()?.connState}`);

  // ── re-enable Y ─────────────────────────────────────────────────────────────
  manager.reconcile([pX, { ...pY, enabled: true }]);
  const yBack = await waitFor(() => manager.connections.get("prof-Y")?.connState === "connected");
  yBack ? pass("re-enabling Y reconnected it") : fail(`Y did not reconnect: ${connY()?.connState}`);

  // cleanup
  await ax.close().catch(() => {});
  await ay.close().catch(() => {});
  await ax2.close().catch(() => {});
  for (const c of manager.connections.values()) c.teardown();
  bridgeX.kill("SIGKILL");
  bridgeY.kill("SIGKILL");

  console.log("");
  if (failures === 0) {
    console.log("✓ All profile-harness checks passed.");
    process.exit(0);
  }
  console.log(`✗ ${failures} check(s) failed.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
