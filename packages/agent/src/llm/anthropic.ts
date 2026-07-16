import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import {
  type LlmProvider,
  type LlmSession,
  type SessionDeps,
  type McpToolDef,
  printToolStart,
  printToolEnd,
} from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";

function toAnthropicTool(t: McpToolDef): Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Tool["input_schema"],
  };
}

class AnthropicSession implements LlmSession {
  private messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly deps: SessionDeps
  ) {}

  async send(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });
    const tools = (await this.deps.listTools()).map(toAnthropicTool);

    let response = await this.client.messages.create({
      model: this.deps.model,
      max_tokens: 8192,
      system: this.deps.systemPrompt,
      messages: this.messages,
      tools,
    });

    while (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // Run the batch concurrently — when the model drives several tabs at once,
      // their tool calls execute in parallel (the extension serializes same-tab
      // work). Results match by tool_use_id, so order is irrelevant to Anthropic;
      // Promise.all preserves array order anyway, and each task resolves (never
      // rejects) to a tool_result block.
      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
          printToolStart(tu.name);
          try {
            const out = await this.deps.callTool(tu.name, tu.input as Record<string, unknown>);
            printToolEnd(true);
            return { type: "tool_result", tool_use_id: tu.id, content: out };
          } catch (err) {
            printToolEnd(false, String(err));
            return { type: "tool_result", tool_use_id: tu.id, content: `Error: ${err}`, is_error: true };
          }
        })
      );

      this.messages.push({ role: "assistant", content: response.content });
      this.messages.push({ role: "user", content: results });

      response = await this.client.messages.create({
        model: this.deps.model,
        max_tokens: 8192,
        system: this.deps.systemPrompt,
        messages: this.messages,
        tools,
      });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    this.messages.push({ role: "assistant", content: response.content });
    return text;
  }
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  defaultModel: DEFAULT_MODEL,
  isConfigured: () => !!process.env.ANTHROPIC_API_KEY,
  missingKeyMessage: () => "ANTHROPIC_API_KEY is not set.",
  createSession(deps: SessionDeps): LlmSession {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return new AnthropicSession(client, deps);
  },
};
