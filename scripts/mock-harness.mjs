// Automated multi-tab / multi-agent test harness — no Chrome required.
//
// It wires the three real layers together and mocks only the browser:
//   • the REAL bridge-server (spawned from dist) — MCP face + WS face
//   • a fake "extension": a WS client that runs the REAL Executor from
//     packages/extension against a mocked chrome.* API
//   • REAL MCP clients (StreamableHTTP) = agents/sessions
//
// Asserts: distinct per-session tab handles, cross-tab parallelism vs same-tab
// serialization, per-session isolation (tab_not_owned + tab_list scoping), tab
// cleanup on graceful session end (DELETE), and idle-reaping of a silent session.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "harness-token";
const NAV_DELAY_MS = 300; // simulated page-load latency, to time parallelism

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};
const firstText = (r) => (r?.content ?? []).find((p) => p.type === "text")?.text ?? "";
const isErr = (r) => !!r?.isError;
const tabTotal = (ex) => [...ex.sessions.values()].reduce((n, s) => n + s.tabs.size, 0);

// ── mock chrome.* (shared store; each mock extension gets its own Executor) ────
let nextTabId = 100;
const tabs = new Map(); // id -> { id, url, title, active }
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
        return setTimeout(() => cb({}), NAV_DELAY_MS);
      }
      if (method === "Runtime.evaluate") {
        const e = params.expression;
        const value = e.includes("document.readyState") ? "complete" : `SNAPSHOT[${t ? t.url : "?"}]`;
        return cb({ result: { value } });
      }
      if (method === "Page.captureScreenshot") return cb({ data: "AAAA" });
      return cb({});
    },
  },
};

const { Executor } = await import("../packages/extension/src/executor.js");

/** Spawn the real bridge and wait for /health. */
async function startBridge({ mcpPort, wsPort, idleMs }) {
  const proc = spawn("node", ["packages/bridge-server/dist/index.js"], {
    env: { ...process.env, BRIDGE_ACCESS_TOKEN: TOKEN, MCP_PORT: String(mcpPort), WS_PORT: String(wsPort), SESSION_IDLE_MS: String(idleMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[bridge] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[bridge:err] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${mcpPort}/health`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error("bridge did not become healthy");
}

/** Fake extension: real Executor + mock chrome, over a real WS to the bridge. */
function startMockExtension(wsPort) {
  let ws;
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  const executor = new Executor((attached, tabId, url, reason) =>
    send({ t: "status", attached, tabId: tabId ?? null, url: url ?? null, reason, sessions: executor.sessionsSummary() })
  );
  const ready = new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${wsPort}`);
    ws.on("open", () => send({ t: "hello", token: TOKEN, ext: "mock", v: 1, profile: "Mock" }));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === "welcome") {
        send({ t: "status", attached: false, tabId: null, url: null, sessions: [] });
        resolve();
      } else if (m.t === "ping") send({ t: "pong" });
      else if (m.t === "cmd")
        executor
          .execute(m.name, m.args || {}, m.deadlineMs, m.sessionId)
          .then((result) => send({ t: "res", id: m.id, ok: true, result }))
          .catch((e) => send({ t: "res", id: m.id, ok: false, error: { code: e.code || "error", message: String(e.message || e) } }));
      else if (m.t === "session_open") executor.getSession(m.sessionId);
      else if (m.t === "session_close") executor.closeSession(m.sessionId).finally(() => send({ t: "session_closed", sessionId: m.sessionId }));
    });
    ws.on("error", reject);
  });
  return { executor, ready, close: () => ws.close() };
}

const newClient = async (name, mcpPort) => {
  const c = new Client({ name, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${mcpPort}/mcp`));
  await c.connect(transport);
  return { client: c, transport };
};

// ── suite 1: multi-tab, parallelism, isolation, graceful teardown ─────────────
async function mainSuite() {
  const mcpPort = 3900, wsPort = 3902;
  const bridge = await startBridge({ mcpPort, wsPort, idleMs: 30 * 60_000 });
  const ext = startMockExtension(wsPort);
  await ext.ready;
  console.log(`Suite 1: bridge ${mcpPort}, mock extension connected\n`);

  const { client: A, transport: transportA } = await newClient("agent-A", mcpPort);
  const { client: B } = await newClient("agent-B", mcpPort);
  pass("two MCP clients connected (two sessions)");

  const status = JSON.parse(firstText(await A.callTool({ name: "check_local_status", arguments: {} })));
  status.chrome_debug_accessible ? pass("check_local_status: extension ready") : fail(`extension not ready: ${status.message}`);

  const hA = firstText(await A.callTool({ name: "browser_tab_new", arguments: { url: "https://example.com/" } })).match(/\bt\d+\b/)?.[0];
  const hB = firstText(await A.callTool({ name: "browser_tab_new", arguments: { url: "https://example.org/" } })).match(/\bt\d+\b/)?.[0];
  hA && hB && hA !== hB ? pass(`distinct tab handles (${hA}, ${hB})`) : fail(`bad handles: ${hA}/${hB}`);

  const sA = firstText(await A.callTool({ name: "browser_snapshot", arguments: { tab: hA } }));
  const sB = firstText(await A.callTool({ name: "browser_snapshot", arguments: { tab: hB } }));
  sA.includes("example.com") && sB.includes("example.org") ? pass("snapshots are per-tab and independent") : fail(`snapshot mismatch: ${sA} / ${sB}`);

  const t0 = Date.now();
  await Promise.all([
    A.callTool({ name: "browser_navigate", arguments: { tab: hA, url: "https://example.com/a" } }),
    A.callTool({ name: "browser_navigate", arguments: { tab: hB, url: "https://example.org/b" } }),
  ]);
  const parallelMs = Date.now() - t0;
  parallelMs < NAV_DELAY_MS * 1.8 ? pass(`cross-tab navigations ran in parallel (${parallelMs}ms ≈ 1×${NAV_DELAY_MS})`) : fail(`cross-tab did not parallelize (${parallelMs}ms)`);

  const t1 = Date.now();
  await Promise.all([
    A.callTool({ name: "browser_navigate", arguments: { tab: hA, url: "https://example.com/x" } }),
    A.callTool({ name: "browser_navigate", arguments: { tab: hA, url: "https://example.com/y" } }),
  ]);
  const serialMs = Date.now() - t1;
  serialMs >= NAV_DELAY_MS * 1.8 ? pass(`same-tab navigations serialized by per-tab lock (${serialMs}ms ≈ 2×${NAV_DELAY_MS})`) : fail(`same-tab did not serialize (${serialMs}ms)`);

  const listB = firstText(await B.callTool({ name: "browser_tab_list", arguments: {} }));
  !listB.includes("example.com") && listB.includes("no tabs") ? pass("session B does not see session A's tabs") : fail(`isolation leak in tab_list: ${listB}`);

  const cross = await B.callTool({ name: "browser_snapshot", arguments: { tab: hA } });
  isErr(cross) && /not owned/i.test(firstText(cross)) ? pass("session B rejected using session A's handle (tab_not_owned)") : fail(`expected tab_not_owned, got: ${firstText(cross)}`);

  const hB1 = firstText(await B.callTool({ name: "browser_tab_new", arguments: { url: "https://b.example/" } })).match(/\bt\d+\b/)?.[0];
  hB1 === "t1" ? pass("session B handle namespace is independent (its first tab is t1)") : fail(`B first handle was ${hB1}, expected t1`);

  tabTotal(ext.executor) === 3 ? pass("extension tracks 3 tabs across 2 sessions") : fail(`expected 3 tabs, got ${tabTotal(ext.executor)}`);

  await transportA.terminateSession(); // DELETE → server onclose → hub.closeSession
  await A.close();
  await sleep(400);
  tabTotal(ext.executor) === 1 ? pass("terminating agent A cleaned up only its tabs (1 left, B's)") : fail(`after A terminate expected 1 tab, got ${tabTotal(ext.executor)}`);

  await B.close();
  ext.close();
  bridge.kill("SIGKILL");
}

// ── suite 2: idle reaping of a silent (crashed) session ───────────────────────
async function reaperSuite() {
  const mcpPort = 3910, wsPort = 3912, idleMs = 700;
  const bridge = await startBridge({ mcpPort, wsPort, idleMs });
  const ext = startMockExtension(wsPort);
  await ext.ready;
  console.log(`\nSuite 2: bridge ${mcpPort} (idle reap ${idleMs}ms)\n`);

  const { client: C } = await newClient("agent-C", mcpPort);
  await C.callTool({ name: "browser_tab_new", arguments: { url: "https://crash.example/" } });
  tabTotal(ext.executor) === 1 ? pass("silent agent C opened 1 tab") : fail(`expected 1 tab, got ${tabTotal(ext.executor)}`);

  // C goes silent (simulating a crash — never sends DELETE). Wait past idle + sweep.
  await sleep(idleMs * 2 + 300);
  tabTotal(ext.executor) === 0 ? pass("idle reaper tore down the silent session's tab") : fail(`expected 0 tabs after reap, got ${tabTotal(ext.executor)}`);

  await C.close().catch(() => {});
  ext.close();
  bridge.kill("SIGKILL");
}

async function main() {
  process.on("exit", () => {});
  await mainSuite();
  await reaperSuite();
  console.log();
  if (failures === 0) {
    console.log("✓ All harness checks passed.");
    process.exit(0);
  }
  console.log(`✗ ${failures} check(s) failed.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
