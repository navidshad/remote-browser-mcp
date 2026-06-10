#!/usr/bin/env node
// Direct live test of the LLM provider tool-use loop (bypasses readline).
// Wires daemon + Playwright MCP, builds the neutral tool list, creates a session,
// and runs one real task end-to-end. Prints the final answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { selectProvider, type McpToolDef } from "./llm/index.js";

const DAEMON_URL = process.env.DAEMON_URL ?? "http://localhost:3001/mcp";
const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_URL ?? "http://localhost:3000";
const TASK = process.env.TASK ?? "Open a new tab, navigate to https://example.com, and tell me the exact page title.";

type Part = { type: string; text?: string };
const firstText = (r: unknown): string =>
  ((r as { content?: Part[] }).content ?? []).find((p) => p.type === "text")?.text ?? "";
const getContent = (r: unknown): Part[] => (r as { content?: Part[] }).content ?? [];

async function connectPlaywright(): Promise<Client> {
  const base = PLAYWRIGHT_URL.replace(/\/$/, "");
  const c = new Client({ name: "live-test", version: "0.1.0" });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    return c;
  } catch {
    const fb = new Client({ name: "live-test", version: "0.1.0" });
    await fb.connect(new SSEClientTransport(new URL(`${base}/sse`)));
    return fb;
  }
}

async function main() {
  const provider = selectProvider(process.env.LLM_PROVIDER || undefined);
  const model = process.env.MODEL || provider.defaultModel;
  console.log(`Provider=${provider.name} Model=${model}`);
  if (!provider.isConfigured()) {
    console.error(provider.missingKeyMessage());
    process.exit(1);
  }

  const daemon = new Client({ name: "live-test", version: "0.1.0" });
  await daemon.connect(new StreamableHTTPClientTransport(new URL(DAEMON_URL)));
  let playwright: Client | null = await connectPlaywright();
  console.log("Connected to daemon + Playwright MCP.");

  const sources = new Map<string, "daemon" | "playwright">();
  const buildToolList = async (): Promise<McpToolDef[]> => {
    const tools: McpToolDef[] = [];
    sources.clear();
    for (const t of (await daemon.listTools()).tools) {
      tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      sources.set(t.name, "daemon");
    }
    if (playwright) {
      for (const t of (await playwright.listTools()).tools) {
        tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
        sources.set(t.name, "playwright");
      }
    }
    return tools;
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const source = sources.get(name);
    if (source === "daemon") return firstText(await daemon.callTool({ name, arguments: args }));
    if (source === "playwright" && playwright) {
      const res = await playwright.callTool({ name, arguments: args });
      const parts = getContent(res);
      return parts.find((p) => p.type === "text")?.text ?? JSON.stringify(parts);
    }
    throw new Error(`Unknown tool: ${name}`);
  };

  const session = provider.createSession({
    systemPrompt:
      "You are a browser automation agent with access to a real Chrome browser. " +
      "Before browser tools, call check_local_status. When navigating, open a new tab. Be concise.",
    model,
    listTools: buildToolList,
    callTool,
  });

  console.log(`\nTask: ${TASK}\n--- tool calls ---`);
  const answer = await session.send(TASK);
  console.log(`\n--- final answer ---\n${answer || "(empty)"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
