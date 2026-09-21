import { AnthropicLlmProvider } from './anthropic.ts';
import { OpenRouterLlmProvider } from './openrouter.ts';
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
export {
  OpenRouterLlmProvider,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MAX_RETRIES,
  OPENROUTER_DEFAULT_MAX_TOKENS,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_TIMEOUT_MS,
  openRouterModelId,
} from './openrouter.ts';
export type { OpenRouterLlmProviderOptions } from './openrouter.ts';
export { DisabledLlmProvider } from './types.ts';
export type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus, LlmTextRequest } from './types.ts';

const DISABLED_FLAG = /^(0|false|off|no|disabled?)$/i;

export const LLM_PROVIDERS = ['anthropic', 'openrouter', 'none'] as const;
export type LlmProviderKind = (typeof LLM_PROVIDERS)[number];

/**
 * Build the LLM provider from environment variables.
 * - `LLM_PROVIDER=anthropic|openrouter|none` picks explicitly; unset → OpenRouter when `OPENROUTER_API_KEY` is set,
 *   else Anthropic when `ANTHROPIC_API_KEY` is set, else none.
 * - OpenRouter: key `OPENROUTER_API_KEY`, model `LLM_MODEL` (OpenRouter id such as `anthropic/claude-sonnet-5`; a bare
 *   Anthropic id gets the `anthropic/` prefix), base URL `OPENROUTER_BASE_URL`.
 * - Anthropic: key `ANTHROPIC_API_KEY`, model `LLM_MODEL`, base URL `ANTHROPIC_BASE_URL`;
 *   `ANTHROPIC_REFUSAL_FALLBACKS=off|false|0|no` disables server-side refusal fallbacks (on by default for
 *   claude-opus-5 / claude-fable-5-1 / claude-mythos-5-1).
 * - none / no key → DisabledLlmProvider (deterministic engines only; status UNAVAILABLE).
 */
export function createLlmProvider(env: Record<string, string | undefined>): LlmProvider {
  const kind = env.LLM_PROVIDER?.trim().toLowerCase() || '';
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (kind === 'none') return new DisabledLlmProvider('LLM disabled (LLM_PROVIDER=none): deterministic engines active');
  if (kind === 'openrouter' || (!kind && openRouterKey)) {
    if (!openRouterKey) return new DisabledLlmProvider('LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set: deterministic engines active');
    return new OpenRouterLlmProvider({ apiKey: openRouterKey, model: env.LLM_MODEL?.trim() || undefined, baseUrl: env.OPENROUTER_BASE_URL?.trim() || undefined });
  }
  if (!anthropicKey) {
    return new DisabledLlmProvider(
      kind === 'anthropic' ? 'LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set: deterministic engines active' : undefined,
    );
  }
  const fallbacksFlag = env.ANTHROPIC_REFUSAL_FALLBACKS?.trim();
  return new AnthropicLlmProvider({
    apiKey: anthropicKey,
    model: env.LLM_MODEL?.trim() || undefined,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    refusalFallbacks: fallbacksFlag ? !DISABLED_FLAG.test(fallbacksFlag) : undefined,
  });
}
