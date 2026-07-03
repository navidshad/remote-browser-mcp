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
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

const hub = new ExtensionHub(TOKEN);

/** Map the hub's connectivity to the ChromeStatus shape the agent already expects. */
function localStatus() {
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
  return {
    online: true,
    chrome_running: true,
    chrome_debug_accessible: true,
    message: "Bridge online and the agent browser (Aso Dara) is connected and ready for remote control.",
  };
}

function buildServer(): McpServer {
  const srv = new McpServer({ name: "remote-browser-bridge", version: "0.1.0" });

  // Status tool — same name/shape as the daemon's so CONTRACT.md is unchanged.
  srv.tool(
    "check_local_status",
    "Check whether the agent browser (Aso Dara) is connected and ready for remote control. " +
      "Call this before issuing browser commands.",
    { notify: z.boolean().optional().describe("Reserved; accepted for compatibility") },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(localStatus(), null, 2) }],
    })
  );

  // Browser tools — forwarded verbatim to the extension over the WS. The
  // extension guarantees MCP-shaped content; cast through the SDK type at the
  // boundary (text parts carry `text`, image parts carry `data`+`mimeType`).
  for (const tool of BROWSER_TOOLS) {
    srv.tool(tool.name, tool.description, tool.schema, async (args) => {
      const result = await hub.sendCommand(
        tool.name,
        (args ?? {}) as Record<string, unknown>,
        tool.timeoutMs
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

// Stateless Streamable HTTP — new server+transport per request (like the daemon).
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  const srv = buildServer();
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
