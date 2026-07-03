#!/usr/bin/env node
import readline from "readline";
import { selectProvider } from "./llm/index.js";
import { McpBridge } from "./mcp.js";

// ── Config from env ──────────────────────────────────────────────────────────
const DAEMON_URL = process.env.DAEMON_URL ?? "http://localhost:3001/mcp";
const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_URL ?? "http://localhost:3000";
const provider = selectProvider(process.env.LLM_PROVIDER || undefined);
// `||` not `??`: an empty MODEL="" (e.g. from an unset compose var) falls back too.
const MODEL = process.env.MODEL || provider.defaultModel;

const SYSTEM_PROMPT =
  "You are a browser automation agent with access to a real Chrome browser on the user's local machine. " +
  "Before using any browser tools, call check_local_status (with notify=true on the first call) to confirm the machine is online and Chrome is ready. " +
  "When navigating, always open a new tab rather than reusing existing ones. After a page navigates or a dialog is dismissed, take a fresh browser_snapshot before clicking, since element references from a previous snapshot may be stale. " +
  "Be concise in your responses. Describe what you did and what you found.";

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

  const bridge = new McpBridge(DAEMON_URL, PLAYWRIGHT_URL);

  // Connect to daemon (required)
  process.stdout.write("Connecting to daemon... ");
  try {
    await bridge.connectDaemon();
    console.log("✓");
  } catch (err) {
    console.log(`✗\n  ${err}`);
    console.error("\nCannot reach the daemon. Is it running?");
    process.exit(1);
  }

  // Connect to Playwright MCP (optional — may not be running yet)
  process.stdout.write("Connecting to Playwright MCP... ");
  console.log((await bridge.connectPlaywright()) ? "✓" : "✗ (will retry on first browser command)");

  // Initial status check
  console.log();
  try {
    const status = await bridge.checkStatus();
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

  const initialTools = await bridge.listTools();
  const counts = bridge.toolCounts();
  console.log(
    `\nTools available: ${initialTools.length} (${counts.daemon} daemon + ${counts.playwright} playwright)\n`
  );

  const session = provider.createSession({
    systemPrompt: SYSTEM_PROMPT,
    model: MODEL,
    listTools: () => bridge.listTools(),
    callTool: (name, args) => bridge.callTool(name, args),
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
      console.log("\n" + JSON.stringify(await bridge.checkStatus(), null, 2) + "\n");
      rl.prompt();
      continue;
    }

    if (input === "/tools") {
      const t = await bridge.listTools();
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
