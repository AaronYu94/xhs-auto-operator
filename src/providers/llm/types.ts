import type { CapabilityStatus } from '../../core/types.ts';

/**
 * Optional LLM layer. The system is fully functional without an LLM (deterministic automotive
 * NLU + persona composers). When available, LLM output is ALWAYS validated: evidence quotes must be
 * verbatim substrings of source text and factual claims must verify against Dealer Brain.
 */
export interface LlmStatus {
  provider: string;
  status: CapabilityStatus;
  model: string | null;
  reason: string;
}

export interface LlmJsonRequest {
  /** short machine purpose for logging/audit, e.g. 'intent_refinement' */
  purpose: string;
  system: string;
  prompt: string;
  /** JSON Schema the response must satisfy */
  schema: Record<string, unknown>;
  max_tokens?: number;
}

export interface LlmTextRequest {
  purpose: string;
  system: string;
  prompt: string;
  max_tokens?: number;
}

export type LlmResult<T> = { ok: true; data: T; model: string } | { ok: false; reason: string };

export interface LlmProvider {
  readonly name: string;
  status(): LlmStatus;
  completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>>;
  completeText(req: LlmTextRequest): Promise<LlmResult<string>>;
}

export class DisabledLlmProvider implements LlmProvider {
  readonly name = 'none';
  private readonly reason: string;

  constructor(reason = 'No LLM configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY): deterministic engines active') {
    this.reason = reason;
  }

  status(): LlmStatus {
    return { provider: this.name, status: 'UNAVAILABLE', model: null, reason: this.reason };
  }
  async completeJson<T>(): Promise<LlmResult<T>> {
    return { ok: false, reason: this.reason };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: this.reason };
  }
}
