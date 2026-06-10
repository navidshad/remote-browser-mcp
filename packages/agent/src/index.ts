#!/usr/bin/env node
import readline from "readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { selectProvider, type McpToolDef } from "./llm/index.js";

// ── Config from env ──────────────────────────────────────────────────────────
const DAEMON_URL = process.env.DAEMON_URL ?? "http://localhost:3001/mcp";
const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_URL ?? "http://localhost:3000";
const provider = selectProvider(process.env.LLM_PROVIDER || undefined);
// `||` not `??`: an empty MODEL="" (e.g. from an unset compose var) falls back too.
const MODEL = process.env.MODEL || provider.defaultModel;

// ── MCP result helpers ───────────────────────────────────────────────────────
// The SDK types callTool's return with a string index signature, which widens
// `.content` to unknown at the call site. These helpers narrow it once.

type McpContentPart = { type: string; text?: string; data?: string; mimeType?: string };

function getContent(result: unknown): McpContentPart[] {
  return (result as { content?: McpContentPart[] }).content ?? [];
}

function firstText(result: unknown): string {
  const text = getContent(result).find((p) => p.type === "text")?.text;
  return text ?? "";
}

// ── MCP client helpers ───────────────────────────────────────────────────────

async function connectDaemon(): Promise<Client> {
  const client = new Client({ name: "remote-browser-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(DAEMON_URL));
  await client.connect(transport);
  return client;
}

async function connectPlaywright(): Promise<Client> {
  const client = new Client({ name: "remote-browser-agent", version: "0.1.0" });
  // Playwright MCP serves Streamable HTTP at /mcp (preferred) and legacy SSE at /sse.
  // Use Streamable HTTP, falling back to SSE if the endpoint is older.
  const base = PLAYWRIGHT_URL.replace(/\/$/, "");
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    return client;
  } catch {
    const fallback = new Client({ name: "remote-browser-agent", version: "0.1.0" });
    const sse = new SSEClientTransport(new URL(`${base}/sse`));
    await fallback.connect(sse);
    return fallback;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║      Remote Browser MCP Agent        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();
  console.log(`Daemon    : ${DAEMON_URL}`);
  console.log(`Playwright: ${PLAYWRIGHT_URL}`);
  console.log(`Provider  : ${provider.name}`);
  console.log(`Model     : ${MODEL}`);
  console.log();

  if (!provider.isConfigured()) {
    console.error(`Error: ${provider.missingKeyMessage()}`);
    process.exit(1);
  }

  // Connect to daemon (required)
  let daemon: Client;
  process.stdout.write("Connecting to daemon... ");
  try {
    daemon = await connectDaemon();
    console.log("✓");
  } catch (err) {
    console.log(`✗\n  ${err}`);
    console.error("\nCannot reach the daemon. Is it running?");
    process.exit(1);
  }

  // Connect to Playwright MCP (optional — may not be running yet)
  let playwright: Client | null = null;
  process.stdout.write("Connecting to Playwright MCP... ");
  try {
    playwright = await connectPlaywright();
    console.log("✓");
  } catch {
    console.log("✗ (will retry on first browser command)");
  }

  // Initial status check
  console.log();
  try {
    const result = await daemon.callTool({ name: "check_local_status", arguments: {} });
    const status = JSON.parse(firstText(result));
    console.log(`Status: ${status.message}`);
    if (!status.chrome_running) {
      console.log(
        "\n⚠  Chrome is not running or remote debugging is not enabled.\n" +
          "   Open Chrome and visit chrome://inspect/#remote-debugging to enable it."
      );
    }
  } catch (err) {
    console.log(`Status check failed: ${err}`);
  }

  // Maps each tool name to the server that owns it. Persistent (not rebuilt fresh
  // each call) so callMcpTool always sees the latest set — including tools from a
  // Playwright server that reconnected mid-session.
  const sources = new Map<string, "daemon" | "playwright">();

  // Gather tools from connected servers in provider-neutral form.
  const buildToolList = async (): Promise<McpToolDef[]> => {
    const tools: McpToolDef[] = [];
    sources.clear();

    const daemonTools = await daemon.listTools();
    for (const t of daemonTools.tools) {
      tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      sources.set(t.name, "daemon");
    }

    // Lazily (re)connect to Playwright MCP so the model always sees browser tools
    // once Chrome is reachable, even if it wasn't up when the agent started.
    if (!playwright) {
      try {
        playwright = await connectPlaywright();
      } catch {
        // still down — only daemon tools this turn
      }
    }

    if (playwright) {
      try {
        const pwTools = await playwright.listTools();
        for (const t of pwTools.tools) {
          tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
          sources.set(t.name, "playwright");
        }
      } catch {
        // Playwright dropped mid-session — forget it so the next turn reconnects
        playwright = null;
      }
    }

    return tools;
  };

  const initialTools = await buildToolList();
  const daemonCount = [...sources.values()].filter((s) => s === "daemon").length;
  const pwCount = [...sources.values()].filter((s) => s === "playwright").length;
  console.log(`\nTools available: ${initialTools.length} (${daemonCount} daemon + ${pwCount} playwright)\n`);

  // Session state — fire the notification once, before the first browser tool call.
  let sessionNotified = false;

  const callMcpTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const source = sources.get(name);

    if (source === "daemon") {
      const res = await daemon.callTool({ name, arguments: args });
      return firstText(res);
    }

    if (source === "playwright") {
      if (!sessionNotified) {
        sessionNotified = true;
        await daemon
          .callTool({ name: "check_local_status", arguments: { notify: true } })
          .catch(() => {});
      }

      if (!playwright) {
        process.stdout.write("\nReconnecting to Playwright MCP... ");
        try {
          playwright = await connectPlaywright();
          console.log("✓");
        } catch (err) {
          throw new Error(`Playwright MCP not reachable: ${err}`);
        }
      }

      const res = await playwright.callTool({ name, arguments: args });
      const parts = getContent(res);
      const text = parts.find((p) => p.type === "text")?.text;
      if (text) return text;
      const img = parts.find((p) => p.type === "image");
      if (img) return "[screenshot captured]";
      return JSON.stringify(parts);
    }

    throw new Error(`Unknown tool: ${name}`);
  };

  // ── LLM session ─────────────────────────────────────────────────────────────
  const SYSTEM_PROMPT =
    "You are a browser automation agent with access to a real Chrome browser on the user's local machine. " +
    "Before using any browser tools, call check_local_status (with notify=true on the first call) to confirm the machine is online and Chrome is ready. " +
    "When navigating, always open a new tab rather than reusing existing ones. " +
    "Be concise in your responses. Describe what you did and what you found.";

  const session = provider.createSession({
    systemPrompt: SYSTEM_PROMPT,
    model: MODEL,
    listTools: buildToolList,
    callTool: callMcpTool,
  });

  // ── Chat loop ─────────────────────────────────────────────────────────────
  // A line queue (rather than `for await (const line of rl)`) so input is handled
  // deterministically whether it's an interactive TTY or piped/buffered stdin —
  // readline's async iterator can drop lines emitted before iteration begins.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  rl.on("line", (l) => {
    queue.push(l);
    wake?.();
    wake = null;
  });
  rl.on("close", () => {
    closed = true;
    wake?.();
    wake = null;
  });

  const nextLine = async (): Promise<string | null> => {
    while (queue.length === 0 && !closed) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() ?? null;
  };

  console.log("Type a command (or /status, /tools, /quit):\n");
  rl.prompt();

  for (let line = await nextLine(); line !== null; line = await nextLine()) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === "/quit" || input === "/exit") {
      break;
    }

    if (input === "/status") {
      const res = await daemon.callTool({ name: "check_local_status", arguments: {} });
      console.log("\n" + JSON.stringify(JSON.parse(firstText(res)), null, 2) + "\n");
      rl.prompt();
      continue;
    }

    if (input === "/tools") {
      const t = await buildToolList();
      console.log(`\n${t.length} tools:`);
      for (const tool of t) console.log(`  • ${tool.name}`);
      console.log();
      rl.prompt();
      continue;
    }

    try {
      const text = await session.send(input);
      if (text) console.log("\n" + text);
    } catch (err) {
      console.error(`\nError: ${err}`);
    }
    rl.prompt();
  }

  rl.close();
  console.log("\nGoodbye.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
