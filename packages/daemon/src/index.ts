#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { checkChromeStatus } from "./status.js";
import { sendNotification } from "./notify.js";

const PORT = parseInt(process.env.PORT ?? "3001");

function buildServer(): McpServer {
  const srv = new McpServer({
    name: "remote-browser-daemon",
    version: "0.1.0",
  });

  srv.tool(
    "check_local_status",
    "Check if the local machine and Chrome browser are online and ready. " +
      "Returns presence and Chrome readiness status. " +
      "Pass notify=true when you are about to issue browser commands — this sends a desktop notification on the local machine so the user knows a session is starting.",
    {
      notify: z
        .boolean()
        .optional()
        .describe("Send a desktop notification that a browser session is starting"),
    },
    async ({ notify }) => {
      const status = await checkChromeStatus();
      if (notify && status.chrome_running) {
        await sendNotification(
          "Remote Browser MCP",
          "An agent started a browser session on your machine"
        );
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  return srv;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "remote-browser-daemon" });
});

// Stateless Streamable HTTP — new server+transport per request
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());
  const srv = buildServer();
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Remote Browser Daemon listening on port ${PORT}`);
  console.log(`  Health : http://localhost:${PORT}/health`);
  console.log(`  MCP    : http://localhost:${PORT}/mcp`);
});
