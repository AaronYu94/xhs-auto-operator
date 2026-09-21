import { structuredOutputSchemaIssue, toStructuredOutputSchema, validateJsonSchema } from './anthropic.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus, LlmTextRequest } from './types.ts';

/**
 * OpenRouter provider over its OpenAI-compatible Chat Completions API (`POST /api/v1/chat/completions`), plain fetch.
 *
 * - JSON: `response_format: {type: 'json_schema', json_schema: {strict: true, schema}}` with the schema adapted to the
 *   structured-output subset, and `provider.require_parameters` so OpenRouter only routes to endpoints that honour it.
 *   The ORIGINAL schema is re-validated client-side (same contract as the Anthropic provider).
 * - Retries 408 / 429 / 5xx and network failures with exponential backoff + jitter, honouring `retry-after`; never
 *   retries 400 / 401 / 402 (no credits) / 403 / 404. Per-attempt timeout; timeouts are not retried (callers fall back
 *   to the deterministic engines).
 * - A truncated (`finish_reason: length`) or filtered answer is a failure, never a partial result.
 * - The API key lives in a true private field and is redacted from every error string.
 * - Records nothing in the database: callers audit their own decisions.
 */

export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MAX_TOKENS = 4000;
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 90_000;
export const OPENROUTER_DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface OpenRouterLlmProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source, injectable for tests */
  random?: () => number;
  initialRetryDelayMs?: number;
}

type JsonObject = Record<string, unknown>;
const isObject = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x);

type Attempt = { kind: 'success'; content: string; model: string } | { kind: 'error'; retryable: boolean; reason: string; retryAfterMs?: number };

/**
 * Map a model id to OpenRouter's naming: ids with a vendor prefix pass through; bare Anthropic ids get the
 * `anthropic/` prefix and a dotted minor version (`claude-fable-5-1` → `anthropic/claude-fable-5.1`).
 */
export function openRouterModelId(model: string | undefined): string {
  const m = model?.trim();
  if (!m) return OPENROUTER_DEFAULT_MODEL;
  if (m.includes('/')) return m;
  return `anthropic/${m.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

/** Model output sometimes arrives inside a ```json fence even with response_format set. */
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

/** The upstream provider's error text inside OpenRouter's `metadata.raw` (itself JSON or plain text). */
function upstreamMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    // plain text
  }
  return raw.slice(0, 300);
}

export class OpenRouterLlmProvider implements LlmProvider {
  readonly name = 'openrouter';
  readonly #apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly initialRetryDelayMs: number;

  constructor(opts: OpenRouterLlmProviderOptions) {
    if (!opts.apiKey?.trim()) throw new Error('OpenRouterLlmProvider: apiKey is required');
    this.#apiKey = opts.apiKey.trim();
    this.model = openRouterModelId(opts.model);
    this.baseUrl = (opts.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? OPENROUTER_DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? OPENROUTER_DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
    this.initialRetryDelayMs = opts.initialRetryDelayMs ?? 500;
  }

  status(): LlmStatus {
    return {
      provider: this.name,
      status: 'AVAILABLE',
      model: this.model,
      reason: `OpenRouter · ${this.model}（输出一律校验；失败时自动回退到规则引擎）`,
    };
  }

  async completeText(req: LlmTextRequest): Promise<LlmResult<string>> {
    const res = await this.call(req, null);
    if (!res.ok) return res;
    const text = res.data.trim();
    return text ? { ok: true, data: text, model: res.model } : { ok: false, reason: `${req.purpose}: empty completion` };
  }

  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    const apiSchema = toStructuredOutputSchema(req.schema);
    const schemaIssue = structuredOutputSchemaIssue(apiSchema);
    if (schemaIssue) return { ok: false, reason: `${req.purpose}: schema not supported by structured outputs: ${schemaIssue}` };
    const res = await this.call(req, apiSchema);
    if (!res.ok) return res;
    let data: unknown;
    try {
      data = JSON.parse(stripFence(res.data));
    } catch {
      return { ok: false, reason: `${req.purpose}: model returned invalid JSON` };
    }
    const issues = validateJsonSchema(data, req.schema);
    if (issues.length) return { ok: false, reason: `${req.purpose}: response failed schema validation: ${issues.slice(0, 5).join('; ')}` };
    return { ok: true, data: data as T, model: res.model };
  }

  private async call(req: LlmTextRequest, schema: JsonObject | null): Promise<LlmResult<string>> {
    const body: JsonObject = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
      max_tokens: req.max_tokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
    };
    if (schema) {
      body.response_format = { type: 'json_schema', json_schema: { name: req.purpose.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'result', strict: true, schema } };
      body.provider = { require_parameters: true };
    }
    let lastReason = 'no attempt made';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const outcome = await this.attempt(body);
      if (outcome.kind === 'success') return { ok: true, data: outcome.content, model: outcome.model };
      lastReason = outcome.reason;
      if (!outcome.retryable || attempt === this.maxRetries) break;
      const backoff = this.initialRetryDelayMs * 2 ** attempt * (0.5 + this.random());
      await this.sleep(Math.min(MAX_RETRY_AFTER_MS, outcome.retryAfterMs ?? backoff));
    }
    return { ok: false, reason: this.redact(`${req.purpose}: ${lastReason}`) };
  }

  private async attempt(body: JsonObject): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', 'x-title': 'xhs-auto-operator' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) return { kind: 'error', retryable: false, reason: `timed out after ${this.timeoutMs} ms` };
      return { kind: 'error', retryable: true, reason: `network error: ${this.redact(err instanceof Error ? err.message : String(err))}` };
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      clearTimeout(timer);
      return { kind: 'error', retryable: !controller.signal.aborted, reason: `could not read response: ${err instanceof Error ? err.message : String(err)}` };
    }
    clearTimeout(timer);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const apiError = isObject(json) && isObject(json.error) ? json.error : null;
    if (!res.ok || apiError) {
      const code = typeof apiError?.code === 'number' ? apiError.code : res.status;
      // "Provider returned error" alone is useless: surface the upstream provider's own message when present.
      const meta = apiError && isObject(apiError.metadata) ? apiError.metadata : null;
      const upstream = typeof meta?.raw === 'string' ? upstreamMessage(meta.raw) : null;
      const base = typeof apiError?.message === 'string' ? apiError.message : raw.slice(0, 300);
      const message = upstream ? `${base} (${typeof meta?.provider_name === 'string' ? `${meta.provider_name}: ` : ''}${upstream})` : base;
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        kind: 'error',
        retryable: RETRYABLE_STATUSES.has(code),
        reason: this.redact(`HTTP ${code}: ${message}`),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }
    const choice = isObject(json) && Array.isArray(json.choices) && isObject(json.choices[0]) ? json.choices[0] : null;
    const message = choice && isObject(choice.message) ? choice.message : null;
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const model = isObject(json) && typeof json.model === 'string' ? json.model : this.model;
    if (typeof message?.refusal === 'string' && message.refusal) return { kind: 'error', retryable: false, reason: `model refused: ${message.refusal.slice(0, 200)}` };
    if (finish === 'length') return { kind: 'error', retryable: false, reason: 'response truncated (max_tokens reached)' };
    if (finish === 'content_filter') return { kind: 'error', retryable: false, reason: 'response blocked by a content filter' };
    if (finish === 'error') return { kind: 'error', retryable: true, reason: 'upstream provider error' };
    if (typeof message?.content !== 'string' || !message.content.trim()) return { kind: 'error', retryable: false, reason: 'empty completion' };
    return { kind: 'success', content: message.content, model };
  }

  private redact(s: string): string {
    return s.split(this.#apiKey).join('[REDACTED]');
  }
}
