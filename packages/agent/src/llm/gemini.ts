import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type Content,
  type Part,
  type FunctionCall,
} from "@google/genai";
import {
  type LlmProvider,
  type LlmSession,
  type SessionDeps,
  type McpToolDef,
  printToolStart,
  printToolEnd,
} from "./types.js";

// gemini-2.5-flash is GA/stable and supports function calling — a safe default
// for an agent that does many tool-call rounds. Override with MODEL=... (e.g.
// gemini-3.5-flash for the newest flash, or gemini-2.5-pro for deeper reasoning).
const DEFAULT_MODEL = "gemini-2.5-flash";

// ── JSON Schema → Gemini (parametersJsonSchema) ───────────────────────────────
// FunctionDeclaration.parametersJsonSchema takes standard JSON Schema directly
// (lowercase types, anyOf, nested objects, additionalProperties, union types) —
// unlike `parameters`, which needs the uppercase `Type` enum. So we pass the MCP
// schema nearly as-is, only dropping pure-metadata keys the validator rejects and
// keeping `required` consistent with `properties`.

type JsonSchema = Record<string, unknown>;

const STRIP_KEYS = new Set(["$schema", "$id"]);

function cleanJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanJsonSchema);
  if (!node || typeof node !== "object") return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (STRIP_KEYS.has(key)) continue;
    out[key] = cleanJsonSchema(value); // recurse into properties, items, anyOf, …
  }

  // Gemini rejects `required` entries that aren't defined in `properties`.
  if (Array.isArray(out.required) && out.properties && typeof out.properties === "object") {
    const props = out.properties as JsonSchema;
    const req = (out.required as unknown[]).filter((r) => typeof r === "string" && r in props);
    if (req.length > 0) out.required = req;
    else delete out.required;
  }

  return out;
}

function toFunctionDeclaration(t: McpToolDef): FunctionDeclaration {
  const schema = cleanJsonSchema(t.inputSchema);
  const props =
    schema && typeof schema === "object" ? (schema as JsonSchema).properties : undefined;
  // Zero-arg tools: omit parameters entirely (Gemini rejects empty-properties objects).
  const hasProps = !!props && typeof props === "object" && Object.keys(props).length > 0;

  return {
    name: t.name,
    description: t.description,
    ...(hasProps ? { parametersJsonSchema: schema } : {}),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

class GeminiSession implements LlmSession {
  private history: Content[] = [];

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly deps: SessionDeps
  ) {}

  async send(userInput: string): Promise<string> {
    this.history.push({ role: "user", parts: [{ text: userInput }] });

    const tools = await this.deps.listTools();
    const decls = tools.map(toFunctionDeclaration);

    const config = {
      systemInstruction: this.deps.systemPrompt,
      maxOutputTokens: 8192,
      tools: decls.length > 0 ? [{ functionDeclarations: decls }] : undefined,
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
      },
    };

    // Gemini is stateless across calls — resend the full history each time.
    let response = await this.ai.models.generateContent({
      model: this.deps.model,
      contents: this.history,
      config,
    });

    // Agentic loop: continue while the model emits function calls.
    while (response.functionCalls && response.functionCalls.length > 0) {
      const calls: FunctionCall[] = response.functionCalls;

      // 1. Echo the model's turn (its functionCall parts) into history FIRST.
      //    A functionResponse with no preceding functionCall is malformed.
      const modelParts: Part[] =
        response.candidates?.[0]?.content?.parts ?? calls.map((c) => ({ functionCall: c }));
      this.history.push({ role: "model", parts: modelParts });

      // 2. Execute each call; collect one functionResponse part per call.
      const responseParts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        printToolStart(name);
        let responseObj: Record<string, unknown>;
        try {
          const out = await this.deps.callTool(name, (call.args ?? {}) as Record<string, unknown>);
          printToolEnd(true);
          // response MUST be an object; Gemini reads the "output"/"error" keys.
          responseObj = { output: out };
        } catch (err) {
          printToolEnd(false, String(err));
          responseObj = { error: String(err) };
        }
        responseParts.push({
          functionResponse: {
            name,
            response: responseObj,
            ...(call.id ? { id: call.id } : {}),
          },
        });
      }

      // 3. Append tool results as a user turn, then loop.
      this.history.push({ role: "user", parts: responseParts });

      response = await this.ai.models.generateContent({
        model: this.deps.model,
        contents: this.history,
        config,
      });
    }

    const finalText = response.text ?? "";
    this.history.push({
      role: "model",
      parts: response.candidates?.[0]?.content?.parts ?? [{ text: finalText }],
    });
    return finalText;
  }
}

export const geminiProvider: LlmProvider = {
  name: "gemini",
  defaultModel: DEFAULT_MODEL,
  isConfigured: () => !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
  missingKeyMessage: () => "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.",
  createSession(deps: SessionDeps): LlmSession {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    const ai = new GoogleGenAI({ apiKey });
    return new GeminiSession(ai, deps);
  },
};
