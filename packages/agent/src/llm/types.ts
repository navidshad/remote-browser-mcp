// Neutral LLM-provider abstraction. The agent's MCP wiring (connections, the
// notification gate, lazy reconnect, callMcpTool) is provider-agnostic; only the
// tool-use loop and message history differ per provider. Each provider owns its
// own history internally and exposes a single send() that runs a full turn.

/** An MCP tool in provider-neutral form. inputSchema is JSON Schema (draft-07/2020-12). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface SessionDeps {
  systemPrompt: string;
  model: string;
  /** Rebuilt each turn so tools from a freshly-reconnected server appear mid-session. */
  listTools: () => Promise<McpToolDef[]>;
  /** Executes a tool by name and returns its text result. Throws on failure. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface LlmSession {
  /** Sends a user message, runs the agentic tool-use loop, returns final assistant text. */
  send(userInput: string): Promise<string>;
}

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  /** Whether the required API key is present in the environment. */
  isConfigured(): boolean;
  /** Human-readable hint when isConfigured() is false. */
  missingKeyMessage(): string;
  createSession(deps: SessionDeps): LlmSession;
}

/** Shared inline progress printer used by every provider's tool-call loop. */
export function printToolStart(name: string): void {
  process.stdout.write(`  [${name}] `);
}
export function printToolEnd(ok: boolean, detail?: string): void {
  process.stdout.write(ok ? "✓\n" : `✗ ${detail ?? ""}\n`);
}
