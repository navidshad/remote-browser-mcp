// Shared MCP wiring used by the REPL and the test runners: holds the daemon and
// Playwright clients, exposes the tool list in provider-neutral form, and routes
// tool calls to the right server. Resilience lives here:
//   • lazy (re)connect to Playwright MCP
//   • a one-time desktop notification before the first browser tool call
//   • reconnect-and-retry when a Playwright call fails because its Streamable HTTP
//     session died (e.g. after an operation timeout) — the new session re-attaches
//     to the same Chrome over CDP, so open tabs persist.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpToolDef } from "./llm/index.js";

type Part = { type: string; text?: string };
const getContent = (r: unknown): Part[] => (r as { content?: Part[] }).content ?? [];
const firstText = (r: unknown): string => getContent(r).find((p) => p.type === "text")?.text ?? "";

/** True for errors that mean the Playwright MCP session is gone and a fresh connect is needed. */
function isSessionError(err: unknown): boolean {
  return /Session not found|Streamable HTTP error|not connected|Connection closed|fetch failed|ECONNREFUSED/i.test(
    String(err)
  );
}

export interface ChromeStatus {
  online: boolean;
  chrome_running: boolean;
  chrome_debug_accessible: boolean;
  message: string;
}

export class McpBridge {
  daemon: Client | null = null;
  private playwright: Client | null = null;
  private sources = new Map<string, "daemon" | "playwright">();
  private notified = false;

  /** Called once, just before the first browser (Playwright) tool call. */
  onFirstBrowserCall?: () => void;

  constructor(
    private readonly daemonUrl: string,
    private readonly playwrightUrl: string
  ) {}

  async connectDaemon(): Promise<void> {
    const c = new Client({ name: "remote-browser-agent", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.daemonUrl)));
    this.daemon = c;
  }

  private async newPlaywright(): Promise<Client> {
    const base = this.playwrightUrl.replace(/\/$/, "");
    const c = new Client({ name: "remote-browser-agent", version: "0.1.0" });
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      return c;
    } catch {
      const fb = new Client({ name: "remote-browser-agent", version: "0.1.0" });
      await fb.connect(new SSEClientTransport(new URL(`${base}/sse`)));
      return fb;
    }
  }

  /** Returns true if Playwright MCP is reachable. Safe to call repeatedly. */
  async connectPlaywright(): Promise<boolean> {
    try {
      this.playwright = await this.newPlaywright();
      return true;
    } catch {
      this.playwright = null;
      return false;
    }
  }

  get playwrightConnected(): boolean {
    return this.playwright !== null;
  }

  async checkStatus(notify = false): Promise<ChromeStatus> {
    const res = await this.daemon!.callTool({
      name: "check_local_status",
      arguments: notify ? { notify: true } : {},
    });
    return JSON.parse(firstText(res)) as ChromeStatus;
  }

  /** Provider-neutral tool list. Refreshes the source map and lazily reconnects Playwright. */
  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    this.sources.clear();

    for (const t of (await this.daemon!.listTools()).tools) {
      tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      this.sources.set(t.name, "daemon");
    }

    if (!this.playwright) await this.connectPlaywright();
    if (this.playwright) {
      try {
        for (const t of (await this.playwright.listTools()).tools) {
          // Dedupe by name: when DAEMON_URL and the browser URL point at the
          // same bridge endpoint (the new single-endpoint setup), check_local_status
          // shows up in both lists — keep the first (daemon) source and skip dupes
          // so the LLM never receives two tools with the same name.
          if (this.sources.has(t.name)) continue;
          tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
          this.sources.set(t.name, "playwright");
        }
      } catch {
        this.playwright = null; // dropped — next turn reconnects
      }
    }

    return tools;
  }

  toolCounts(): { daemon: number; playwright: number } {
    const vals = [...this.sources.values()];
    return {
      daemon: vals.filter((s) => s === "daemon").length,
      playwright: vals.filter((s) => s === "playwright").length,
    };
  }

  private async rawPlaywrightCall(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.playwright) this.playwright = await this.newPlaywright();
    const res = await this.playwright.callTool({ name, arguments: args });
    const parts = getContent(res);
    const text = parts.find((p) => p.type === "text")?.text;
    if (text) return text;
    if (parts.some((p) => p.type === "image")) return "[screenshot captured]";
    return JSON.stringify(parts);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const source = this.sources.get(name);

    if (source === "daemon") {
      return firstText(await this.daemon!.callTool({ name, arguments: args }));
    }

    if (source === "playwright") {
      if (!this.notified) {
        this.notified = true;
        this.onFirstBrowserCall?.();
        await this.daemon!.callTool({ name: "check_local_status", arguments: { notify: true } }).catch(
          () => {}
        );
      }
      try {
        return await this.rawPlaywrightCall(name, args);
      } catch (err) {
        if (!isSessionError(err)) throw err;
        // Session died (often after an operation timeout). Reconnect and retry once.
        this.playwright = null;
        try {
          this.playwright = await this.newPlaywright();
        } catch (e) {
          throw new Error(`Playwright MCP not reachable after reconnect: ${e}`);
        }
        return await this.rawPlaywrightCall(name, args);
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }
}
