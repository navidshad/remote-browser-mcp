import type { LlmProvider } from "./types.js";
import { geminiProvider } from "./gemini.js";
import { anthropicProvider } from "./anthropic.js";

export * from "./types.js";

const PROVIDERS: Record<string, LlmProvider> = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};

/**
 * Selects the LLM provider from LLM_PROVIDER (default: gemini).
 * Throws with a clear message if the name is unknown.
 */
export function selectProvider(name?: string): LlmProvider {
  const key = (name ?? "gemini").toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(
      `Unknown LLM_PROVIDER "${key}". Available: ${Object.keys(PROVIDERS).join(", ")}.`
    );
  }
  return provider;
}
