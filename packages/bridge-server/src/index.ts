#!/usr/bin/env node
// Bridge-server: runs on the VM. Two listeners in one process:
//   • MCP face  (http://localhost:MCP_PORT/mcp) — the VM's Claude Code and the
//     packages/agent test harness connect here as MCP clients. Stateless
//     Streamable HTTP, same pattern as packages/daemon. NOT exposed publicly.
//   • WS  face  (ws://0.0.0.0:WS_PORT)          — the MV3 extension dials in here.
//     Exposed publicly by `cloudflared` on the VM (wss://…), guarded by our own
//     token handshake (no Cloudflare Access — a browser WebSocket can't send the
//     CF-Access-* headers Access needs).
//
// A browser MCP tool call is forwarded over the WS to the extension, which
// executes it via chrome.debugger and returns an MCP-shaped result.
import express from "express";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ExtensionHub } from "./extension-hub.js";
import { BROWSER_TOOLS } from "./tools.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000");
const WS_PORT = parseInt(process.env.WS_PORT ?? "3002");
const TOKEN = process.env.BRIDGE_ACCESS_TOKEN ?? "";

if (!TOKEN) {
  console.error(
    "FATAL: BRIDGE_ACCESS_TOKEN is not set. The extension authenticates with this token; " +
      "refusing to start without it."
  );
  process.exit(1);
}

// Reap a session's tabs after this long with no activity — the backstop for an
// agent that dies without sending a DELETE (0 disables). Default 30 min.
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MS ?? String(30 * 60_000));

const hub = new ExtensionHub(TOKEN, SESSION_IDLE_MS);

/** Map the hub's connectivity to the ChromeStatus shape the agent already expects.
 *  `sessionId` (the caller's MCP session) adds this session's owned-tab count. */
function localStatus(sessionId?: string) {
  const s = hub.getStatus();
  if (!s.extensionConnected) {
    return {
      online: true,
      chrome_running: false,
      chrome_debug_accessible: false,
      message:
        "Bridge is online but the agent browser extension is not connected. " +
        "Open the Aso Dara Chrome window and confirm the Remote Browser extension shows 'connected'.",
    };
  }
  const owned = hub.tabCountFor(sessionId);
  return {
    online: true,
    chrome_running: true,
    chrome_debug_accessible: true,
    tabs_owned: owned,
    message:
      "Bridge online and the agent browser (Aso Dara) is connected and ready for remote control." +
      (owned > 0 ? ` This session owns ${owned} tab(s).` : ""),
  };
}

/** Build an MCP server bound to one caller. `getSessionId` resolves the caller's
 *  MCP session lazily (it isn't known until `initialize` completes), so every tool
 *  call is routed to that session's tab group in the extension. */
function buildServer(getSessionId: () => string | undefined): McpServer {
  const srv = new McpServer({ name: "remote-browser-bridge", version: "0.1.0" });

  // Status tool — same name/shape as the daemon's so CONTRACT.md is unchanged.
  srv.tool(
    "check_local_status",
    "Check whether the agent browser (Aso Dara) is connected and ready for remote control. " +
      "Call this before issuing browser commands.",
    { notify: z.boolean().optional().describe("Reserved; accepted for compatibility") },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(localStatus(getSessionId()), null, 2) }],
    })
  );

  // Browser tools — forwarded verbatim to the extension over the WS, tagged with
  // the caller's sessionId so tab ownership is isolated per agent. The extension
  // guarantees MCP-shaped content; cast through the SDK type at the boundary.
  for (const tool of BROWSER_TOOLS) {
    srv.tool(tool.name, tool.description, tool.schema, async (args) => {
      const result = await hub.sendCommand(
        tool.name,
        (args ?? {}) as Record<string, unknown>,
        tool.timeoutMs,
        getSessionId()
      );
      return result as unknown as CallToolResult;
    });
  }

  return srv;
}

// ── MCP face (localhost only) ────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" })); // screenshots come back as base64

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "remote-browser-bridge", ...hub.getStatus() });
});

// Stateful Streamable HTTP: one transport per MCP session (keyed by Mcp-Session-Id),
// so each connected agent gets an isolated tab group in the extension. The MCP SDK
// client captures the session id on `initialize` and echoes it on every later
// request — the LLM never sees or threads it, so a session can't be spoofed.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;

  // Existing session → reuse its transport (handles POST tool calls, the GET SSE
  // stream, and the DELETE teardown that fires session cleanup via onclose).
  if (sid && transports.has(sid)) {
    await transports.get(sid)!.handleRequest(req, res, req.body);
    return;
  }

  // New session → create a stateful transport on the initialize handshake.
  if (!sid && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        hub.openSession(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        hub.closeSession(id); // tear down this agent's tabs
      }
    };
    const srv = buildServer(() => transport.sessionId);
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Back-compat: a header-less, non-initialize call (e.g. a bare stateless client)
  // runs as a one-shot on the extension's "default" session.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  const srv = buildServer(() => undefined);
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(MCP_PORT, "127.0.0.1", () => {
  console.log(`Remote Browser Bridge — MCP face on http://127.0.0.1:${MCP_PORT}/mcp`);
  console.log(`  Health : http://127.0.0.1:${MCP_PORT}/health`);
});

// ── WS face (public via cloudflared) ─────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
hub.attach(wss);
console.log(`Remote Browser Bridge — WS face on ws://0.0.0.0:${WS_PORT} (extension dials in here)`);
