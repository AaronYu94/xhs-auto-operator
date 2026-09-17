import type { Clock } from '../../core/clock.ts';
import { SystemClock } from '../../core/clock.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus, LlmTextRequest } from './types.ts';

/**
 * Anthropic Claude provider over the Messages API (`POST /v1/messages`) using plain fetch.
 *
 * - JSON: structured outputs via `output_config.format = {type: 'json_schema', schema}`; the schema is
 *   adapted to the structured-output subset (objects get `additionalProperties: false`, unsupported
 *   numeric/string/array constraints are stripped) and the ORIGINAL schema is re-validated client-side.
 * - Retries 429 / 5xx (incl. 529 overloaded) and network failures with exponential backoff + jitter,
 *   honoring `retry-after-ms` / `retry-after`; never retries 400 / 401 / 403. `x-should-retry: false` wins.
 * - Per-attempt timeout via AbortController. Timeouts are not retried (callers fall back to deterministic engines).
 * - The API key lives in a true private field and is redacted from every error string.
 * - Records nothing in the database — callers audit their own decisions.
 */

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 60_000;
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 2;
/** Largest server-requested retry delay we are willing to wait inside one call. */
export const ANTHROPIC_MAX_RETRY_AFTER_MS = 60_000;
/** Beta header gating the scalar `fallbacks: "default"` server-side refusal fallback form. */
export const ANTHROPIC_REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models whose safety classifiers may decline requests; server-side refusal fallbacks are enabled for them by default. */
export const ANTHROPIC_REFUSAL_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
]);
/** String formats accepted by structured outputs; any other `format` is stripped from the API schema. */
const SUPPORTED_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicLlmProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** optional `output_config.effort`; omitted → API default */
  effort?: AnthropicEffort;
  /**
   * Server-side refusal fallbacks (`fallbacks: "default"`) for models in ANTHROPIC_REFUSAL_FALLBACK_MODELS.
   * Default true. If the endpoint rejects the parameter (HTTP 400), the request is resent once without it and
   * fallbacks stay off for the lifetime of this provider.
   */
  refusalFallbacks?: boolean;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source, injectable for tests */
  random?: () => number;
  /** used to resolve HTTP-date `retry-after` values */
  clock?: Clock;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

type JsonObject = Record<string, unknown>;

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

interface MessageResponse {
  model?: unknown;
  content: ContentBlock[];
  stop_reason?: unknown;
  stop_details?: { category?: unknown; explanation?: unknown } | null;
}

type AttemptOutcome =
  | { kind: 'success'; message: MessageResponse }
  | { kind: 'error'; retryable: boolean; reason: string; retryAfterMs?: number; status?: number };

const ACCEPTED_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
const NEVER_RETRY_STATUSES = new Set([400, 401, 403]);

const isObject = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x);

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function truncateText(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    return `${err.name}: ${err.message}${causeMsg}`;
  }
  return String(err);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema helpers
// ─────────────────────────────────────────────────────────────────────────────

const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  '$schema',
  '$id',
]);

const SCHEMA_MAP_KEYS = new Set(['properties', '$defs', 'definitions']);
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);

/**
 * Adapt a caller's JSON Schema to the structured-output subset: every object node gets
 * `additionalProperties: false`, `oneOf` becomes `anyOf`, and constraints the API does not accept are
 * removed (they are still enforced client-side by `validateJsonSchema` against the original schema).
 */
export function toStructuredOutputSchema(schema: JsonObject): JsonObject {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!isObject(node)) return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.has(key)) continue;
      if (key === 'minItems') {
        if (typeof value === 'number' && value <= 1) out.minItems = value;
        continue;
      }
      if (key === 'additionalProperties') continue;
      if (key === 'format') {
        if (typeof value === 'string' && SUPPORTED_STRING_FORMATS.has(value)) out.format = value;
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) {
        const mapped: JsonObject = {};
        for (const [name, sub] of Object.entries(value)) mapped[name] = convert(sub);
        out[key] = mapped;
        continue;
      }
      if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
        out[key === 'oneOf' ? 'anyOf' : key] = value.map(convert);
        continue;
      }
      if ((key === 'items' || key === 'not') && (isObject(value) || Array.isArray(value))) {
        out[key] = convert(value);
        continue;
      }
      out[key] = value;
    }
    const type = node.type;
    const isObjectNode = type === 'object' || (Array.isArray(type) && type.includes('object')) || isObject(node.properties);
    if (isObjectNode) out.additionalProperties = false;
    return out;
  };
  return convert(schema) as JsonObject;
}

/**
 * Returns why a caller schema cannot be honoured by structured outputs, or null when it can.
 * Structured outputs force `additionalProperties: false` on every object, so a free-form object / map
 * (an object node with no declared properties that does not itself forbid extra keys) could only ever be
 * returned as `{}` — silently dropping the data the caller asked for. Such schemas are refused up front.
 */
export function structuredOutputSchemaIssue(schema: JsonObject): string | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string): string | null => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const issue = visit(node[i], `${path}[${i}]`);
        if (issue) return issue;
      }
      return null;
    }
    if (!isObject(node) || seen.has(node)) return null;
    seen.add(node);
    const type = node.type;
    const objectType = type === 'object' || (Array.isArray(type) && type.includes('object'));
    const declared = isObject(node.properties) && Object.keys(node.properties).length > 0;
    const composed = ['anyOf', 'oneOf', 'allOf'].some((k) => Array.isArray(node[k])) || typeof node.$ref === 'string';
    if (objectType && !declared && !composed && node.additionalProperties !== false)
      return `${path}: free-form object (no declared properties) cannot be expressed with structured outputs`;
    if (isObject(node.patternProperties) && !declared)
      return `${path}: patternProperties maps cannot be expressed with structured outputs`;
    for (const [key, value] of Object.entries(node)) {
      if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) {
        for (const [name, sub] of Object.entries(value)) {
          const issue = visit(sub, key === 'properties' ? `${path}.${name}` : `#/${key}/${name}`);
          if (issue) return issue;
        }
      } else if (SCHEMA_LIST_KEYS.has(key) || key === 'items' || key === 'not' || key === 'additionalProperties') {
        const issue = visit(value, key === 'items' ? `${path}[]` : path);
        if (issue) return issue;
      }
    }
    return null;
  };
  return visit(schema, '$');
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = jsonType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

/**
 * Client-side validation of a parsed response against the caller's JSON Schema: type (incl. unions),
 * required keys, nested properties / items, enum / const, anyOf / oneOf / allOf, local `$ref`s and the
 * numeric / string / array constraints stripped from the API schema. Returns human-readable issues.
 */
export function validateJsonSchema(value: unknown, schema: JsonObject, maxIssues = 20): string[] {
  const issues: string[] = [];
  const root = schema;

  const resolveRef = (ref: string): JsonObject | null => {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) return null;
    const defs = root[m[1]];
    if (!isObject(defs)) return null;
    const target = defs[decodeURIComponent(m[2])];
    return isObject(target) ? target : null;
  };

  const walk = (val: unknown, node: unknown, path: string, depth: number): void => {
    if (issues.length >= maxIssues || !isObject(node) || depth > 64) return;
    if (typeof node.$ref === 'string') {
      const target = resolveRef(node.$ref);
      if (target) walk(val, target, path, depth + 1);
      return;
    }

    for (const key of ['anyOf', 'oneOf'] as const) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      if (!branches.some((b) => validateJsonSchemaNode(val, b, root) === 0))
        issues.push(`${path}: does not match any allowed schema (${key})`);
    }
    if (Array.isArray(node.allOf)) for (const b of node.allOf) walk(val, b, path, depth + 1);

    if (node.type !== undefined) {
      const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((t): t is string => typeof t === 'string');
      if (types.length > 0 && !types.some((t) => typeMatches(t, val))) {
        issues.push(`${path}: expected ${types.join('|')}, got ${jsonType(val)}`);
        return;
      }
    }
    if (Array.isArray(node.enum) && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(val)))
      issues.push(`${path}: value not in enum`);
    if ('const' in node && JSON.stringify(node.const) !== JSON.stringify(val)) issues.push(`${path}: value does not equal const`);

    if (typeof val === 'string') {
      const len = [...val].length;
      if (typeof node.minLength === 'number' && len < node.minLength) issues.push(`${path}: shorter than ${node.minLength}`);
      if (typeof node.maxLength === 'number' && len > node.maxLength) issues.push(`${path}: longer than ${node.maxLength}`);
      if (typeof node.pattern === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(node.pattern, 'u');
        } catch {
          re = null;
        }
        if (re && !re.test(val)) issues.push(`${path}: does not match pattern`);
      }
    }
    if (typeof val === 'number') {
      if (typeof node.minimum === 'number' && val < node.minimum) issues.push(`${path}: must be >= ${node.minimum}`);
      if (typeof node.maximum === 'number' && val > node.maximum) issues.push(`${path}: must be <= ${node.maximum}`);
      if (typeof node.exclusiveMinimum === 'number' && val <= node.exclusiveMinimum)
        issues.push(`${path}: must be > ${node.exclusiveMinimum}`);
      if (typeof node.exclusiveMaximum === 'number' && val >= node.exclusiveMaximum)
        issues.push(`${path}: must be < ${node.exclusiveMaximum}`);
    }
    if (Array.isArray(val)) {
      if (typeof node.minItems === 'number' && val.length < node.minItems) issues.push(`${path}: fewer than ${node.minItems} items`);
      if (typeof node.maxItems === 'number' && val.length > node.maxItems) issues.push(`${path}: more than ${node.maxItems} items`);
      if (isObject(node.items)) val.forEach((item, i) => walk(item, node.items, `${path}[${i}]`, depth + 1));
    }
    if (isObject(val)) {
      if (Array.isArray(node.required)) {
        for (const key of node.required)
          if (typeof key === 'string' && val[key] === undefined) issues.push(`${path}: missing required key "${key}"`);
      }
      const props = isObject(node.properties) ? node.properties : {};
      for (const [key, sub] of Object.entries(props))
        if (val[key] !== undefined) walk(val[key], sub, `${path}.${key}`, depth + 1);
      if (node.additionalProperties === false || isObject(node.additionalProperties)) {
        for (const key of Object.keys(val)) {
          if (Object.hasOwn(props, key)) continue;
          if (node.additionalProperties === false) issues.push(`${path}: unexpected key "${key}"`);
          else walk(val[key], node.additionalProperties, `${path}.${key}`, depth + 1);
          if (issues.length >= maxIssues) return;
        }
      }
    }
  };

  walk(value, schema, '$', 0);
  return issues;
}

function validateJsonSchemaNode(value: unknown, node: unknown, root: JsonObject): number {
  if (!isObject(node)) return 0;
  const merged: JsonObject = { ...node };
  for (const key of ['$defs', 'definitions']) if (root[key] !== undefined && merged[key] === undefined) merged[key] = root[key];
  return validateJsonSchema(value, merged, 1).length;
}

function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** whether server-side refusal fallbacks are requested for this model (see ANTHROPIC_REFUSAL_FALLBACK_MODELS) */
  readonly refusalFallbacks: boolean;
  #fallbacksRejected = false;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #clock: Clock;
  readonly #effort: AnthropicEffort | undefined;
  readonly #initialRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;

  constructor(opts: AnthropicLlmProviderOptions) {
    this.#apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    this.model = opts.model?.trim() || ANTHROPIC_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : ANTHROPIC_DEFAULT_TIMEOUT_MS;
    this.maxRetries =
      opts.maxRetries !== undefined && Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0
        ? opts.maxRetries
        : ANTHROPIC_DEFAULT_MAX_RETRIES;
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    this.#clock = opts.clock ?? new SystemClock();
    this.#effort = opts.effort;
    this.#initialRetryDelayMs = opts.initialRetryDelayMs ?? 500;
    this.#maxRetryDelayMs = opts.maxRetryDelayMs ?? 8_000;
    this.refusalFallbacks = opts.refusalFallbacks !== false && ANTHROPIC_REFUSAL_FALLBACK_MODELS.has(this.model);
  }

  status(): LlmStatus {
    if (!this.#apiKey)
      return { provider: this.name, status: 'UNAVAILABLE', model: null, reason: 'Anthropic API key is empty — LLM disabled' };
    const fallbacks = this.refusalFallbacks && !this.#fallbacksRejected ? '; server-side refusal fallbacks on' : '';
    return {
      provider: this.name,
      status: 'AVAILABLE',
      model: this.model,
      reason: `Anthropic Messages API configured (model ${this.model}${fallbacks})`,
    };
  }

  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    if (!isObject(req.schema)) return { ok: false, reason: 'anthropic: request schema must be a JSON Schema object' };
    if (typeof req.prompt !== 'string' || req.prompt.trim() === '')
      return { ok: false, reason: `anthropic ${req.purpose}: prompt is empty` };
    const schemaIssue = structuredOutputSchemaIssue(req.schema);
    if (schemaIssue)
      return { ok: false, reason: `anthropic ${req.purpose}: schema not supported by structured outputs — ${schemaIssue}` };
    const body = this.#baseBody(req.system, req.prompt, req.max_tokens);
    body.output_config = {
      ...(this.#effort ? { effort: this.#effort } : {}),
      format: { type: 'json_schema', schema: toStructuredOutputSchema(req.schema) },
    };

    const res = await this.#send(req.purpose, body);
    if (!res.ok) return res;
    const stop = this.#checkStop(req.purpose, res.message);
    if (stop) return { ok: false, reason: stop };

    const text = this.#text(res.message);
    if (!text.trim()) return { ok: false, reason: `anthropic ${req.purpose}: response contained no JSON text` };
    const data = safeJsonParse(stripCodeFence(text));
    if (data === undefined) return { ok: false, reason: `anthropic ${req.purpose}: response was not valid JSON` };
    const issues = validateJsonSchema(data, req.schema);
    if (issues.length > 0)
      return {
        ok: false,
        reason: this.#redact(`anthropic ${req.purpose}: response failed schema validation — ${issues.slice(0, 5).join('; ')}`),
      };
    return { ok: true, data: data as T, model: this.#modelOf(res.message) };
  }

  async completeText(req: LlmTextRequest): Promise<LlmResult<string>> {
    if (typeof req.prompt !== 'string' || req.prompt.trim() === '')
      return { ok: false, reason: `anthropic ${req.purpose}: prompt is empty` };
    const body = this.#baseBody(req.system, req.prompt, req.max_tokens);
    if (this.#effort) body.output_config = { effort: this.#effort };
    const res = await this.#send(req.purpose, body);
    if (!res.ok) return res;
    const stop = this.#checkStop(req.purpose, res.message);
    if (stop) return { ok: false, reason: stop };
    const text = this.#text(res.message);
    if (!text.trim()) return { ok: false, reason: `anthropic ${req.purpose}: response contained no text` };
    return { ok: true, data: text, model: this.#modelOf(res.message) };
  }

  #baseBody(system: string, prompt: string, maxTokens: number | undefined): JsonObject {
    const body: JsonObject = {
      model: this.model,
      max_tokens:
        maxTokens !== undefined && Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    };
    if (typeof system === 'string' && system.trim() !== '') body.system = system;
    return body;
  }

  #text(message: MessageResponse): string {
    return message.content
      .filter((b): b is ContentBlock & { text: string } => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  #modelOf(message: MessageResponse): string {
    return typeof message.model === 'string' && message.model ? message.model : this.model;
  }

  #checkStop(purpose: string, message: MessageResponse): string | null {
    const reason = message.stop_reason;
    if (reason === undefined || reason === null || (typeof reason === 'string' && ACCEPTED_STOP_REASONS.has(reason)))
      return null;
    if (reason === 'refusal') {
      const category = message.stop_details && typeof message.stop_details.category === 'string' ? ` (${message.stop_details.category})` : '';
      return `anthropic ${purpose}: model declined the request${category}`;
    }
    if (reason === 'max_tokens') return `anthropic ${purpose}: output truncated at max_tokens`;
    return `anthropic ${purpose}: unexpected stop_reason ${String(reason)}`;
  }

  #redact(text: string): string {
    let out = text;
    if (this.#apiKey) out = out.split(this.#apiKey).join('[REDACTED]');
    return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
  }

  async #send(purpose: string, body: JsonObject): Promise<{ ok: true; message: MessageResponse } | { ok: false; reason: string }> {
    if (!this.#apiKey) return { ok: false, reason: 'anthropic: API key is empty — LLM disabled' };
    const url = `${this.baseUrl}/v1/messages`;
    let useFallbacks = this.refusalFallbacks && !this.#fallbacksRejected;
    let retriesUsed = 0;
    for (let attempts = 1; ; attempts++) {
      const payload = JSON.stringify(useFallbacks ? { ...body, fallbacks: 'default' } : body);
      const extraHeaders: Record<string, string> = useFallbacks ? { 'anthropic-beta': ANTHROPIC_REFUSAL_FALLBACK_BETA } : {};
      const outcome = await this.#attempt(url, payload, extraHeaders);
      if (outcome.kind === 'success') return { ok: true, message: outcome.message };

      if (useFallbacks && outcome.status === 400 && /fallback|anthropic-beta/i.test(outcome.reason)) {
        // The endpoint (e.g. a gateway or a cloud platform without server-side fallbacks) rejected the beta
        // parameter itself: resend once without it and stop requesting it on this provider.
        this.#fallbacksRejected = true;
        useFallbacks = false;
        continue;
      }

      const suffix = attempts > 1 ? ` (after ${attempts} attempts)` : '';
      if (!outcome.retryable || retriesUsed >= this.maxRetries)
        return { ok: false, reason: this.#redact(`anthropic ${purpose}: ${outcome.reason}${suffix}`) };
      if (outcome.retryAfterMs !== undefined && outcome.retryAfterMs > ANTHROPIC_MAX_RETRY_AFTER_MS)
        return {
          ok: false,
          reason: this.#redact(
            `anthropic ${purpose}: ${outcome.reason}; server asked to retry after ${Math.ceil(outcome.retryAfterMs / 1000)}s${suffix}`,
          ),
        };
      await this.#sleep(this.#retryDelay(retriesUsed, outcome.retryAfterMs));
      retriesUsed++;
    }
  }

  #retryDelay(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined && retryAfterMs >= 0) return Math.ceil(retryAfterMs);
    const base = Math.min(this.#initialRetryDelayMs * 2 ** attempt, this.#maxRetryDelayMs);
    const jitter = 1 - Math.min(1, Math.max(0, this.#random())) * 0.25;
    return Math.round(base * jitter);
  }

  #retryAfter(headers: Headers): number | undefined {
    const ms = headers.get('retry-after-ms');
    if (ms !== null && ms.trim() !== '') {
      const n = Number(ms);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const ra = headers.get('retry-after');
    if (ra === null || ra.trim() === '') return undefined;
    const seconds = Number(ra);
    if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
    const at = Date.parse(ra);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, at - this.#clock.now().getTime());
  }

  async #attempt(url: string, payload: string, extraHeaders: Record<string, string>): Promise<AttemptOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    timeout.catch(() => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const timeoutReason = `request timed out after ${this.timeoutMs}ms`;

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.#fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'anthropic-version': ANTHROPIC_API_VERSION,
              ...extraHeaders,
              'x-api-key': this.#apiKey,
            },
            body: payload,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch (err) {
        if (timedOut) return { kind: 'error', retryable: false, reason: timeoutReason };
        return { kind: 'error', retryable: true, reason: `network error — ${errorMessage(err)}` };
      }

      let raw: string;
      try {
        raw = await Promise.race([response.text(), timeout]);
      } catch (err) {
        if (timedOut) return { kind: 'error', retryable: false, reason: timeoutReason };
        return { kind: 'error', retryable: true, reason: `failed to read response body — ${errorMessage(err)}` };
      }

      if (!response.ok) {
        const parsed = safeJsonParse(raw);
        const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
        const errType = error && typeof error.type === 'string' ? ` ${error.type}` : '';
        const errMsg = error && typeof error.message === 'string' ? `: ${truncateText(error.message, 300)}` : '';
        const requestId =
          (isObject(parsed) && typeof parsed.request_id === 'string' ? parsed.request_id : null) ??
          response.headers.get('request-id');
        const shouldRetryHeader = response.headers.get('x-should-retry');
        const status = response.status;
        let retryable = status === 429 || status >= 500;
        if (shouldRetryHeader === 'true' && !NEVER_RETRY_STATUSES.has(status)) retryable = true;
        if (shouldRetryHeader === 'false' || NEVER_RETRY_STATUSES.has(status)) retryable = false;
        return {
          kind: 'error',
          retryable,
          reason: `HTTP ${status}${errType}${errMsg}${requestId ? ` (request_id ${requestId})` : ''}`,
          retryAfterMs: this.#retryAfter(response.headers),
          status,
        };
      }

      const parsed = safeJsonParse(raw);
      if (!isObject(parsed) || !Array.isArray(parsed.content))
        return { kind: 'error', retryable: false, reason: 'unexpected response shape from Messages API' };
      return { kind: 'success', message: parsed as unknown as MessageResponse };
    } finally {
      clearTimeout(timer);
    }
  }
}
