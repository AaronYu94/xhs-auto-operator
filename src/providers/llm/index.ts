import { AnthropicLlmProvider } from './anthropic.ts';
import { DisabledLlmProvider, type LlmProvider } from './types.ts';

export {
  AnthropicLlmProvider,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_RETRIES,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_TIMEOUT_MS,
  ANTHROPIC_MAX_RETRY_AFTER_MS,
  ANTHROPIC_REFUSAL_FALLBACK_BETA,
  ANTHROPIC_REFUSAL_FALLBACK_MODELS,
  structuredOutputSchemaIssue,
  toStructuredOutputSchema,
  validateJsonSchema,
} from './anthropic.ts';
export type { AnthropicEffort, AnthropicLlmProviderOptions } from './anthropic.ts';
export { DisabledLlmProvider } from './types.ts';
export type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus, LlmTextRequest } from './types.ts';

const DISABLED_FLAG = /^(0|false|off|no|disabled?)$/i;

/**
 * Build the LLM provider from environment variables.
 * - `ANTHROPIC_API_KEY` (non-blank) → AnthropicLlmProvider, model from `LLM_MODEL`, base URL from `ANTHROPIC_BASE_URL`;
 *   `ANTHROPIC_REFUSAL_FALLBACKS=off|false|0|no` disables server-side refusal fallbacks (on by default for
 *   claude-opus-5 / claude-fable-5-1 / claude-mythos-5-1).
 * - otherwise → DisabledLlmProvider (deterministic engines only; status UNAVAILABLE).
 */
export function createLlmProvider(env: Record<string, string | undefined>): LlmProvider {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new DisabledLlmProvider();
  const fallbacksFlag = env.ANTHROPIC_REFUSAL_FALLBACKS?.trim();
  return new AnthropicLlmProvider({
    apiKey,
    model: env.LLM_MODEL?.trim() || undefined,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    refusalFallbacks: fallbacksFlag ? !DISABLED_FLAG.test(fallbacksFlag) : undefined,
  });
}
