import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { ManualClock } from '../../../src/core/clock.ts';
import {
  AnthropicLlmProvider,
  structuredOutputSchemaIssue,
  toStructuredOutputSchema,
  validateJsonSchema,
  type AnthropicLlmProviderOptions,
} from '../../../src/providers/llm/anthropic.ts';
import { createLlmProvider } from '../../../src/providers/llm/index.ts';
import { DisabledLlmProvider } from '../../../src/providers/llm/types.ts';

const KEY = 'sk-ant-api03-TEST-SECRET-0123456789abcdef';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: any;
  signal: AbortSignal | null | undefined;
}

type Responder = (call: Call) => Response | Promise<Response>;

function fakeFetch(responders: Responder[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    };
    calls.push(call);
    return responders[Math.min(calls.length - 1, responders.length - 1)](call);
  }) as typeof fetch;
  return { impl, calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const messageResponse = (text: string, extra: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 42, output_tokens: 17 },
    ...extra,
  });

const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  jsonResponse(status, { type: 'error', error: { type, message }, request_id: 'req_011TEST' }, headers);

const SCHEMA = {
  type: 'object',
  properties: {
    is_purchase_signal: { type: 'boolean' },
    purchase_stage: { type: 'string', enum: ['research', 'price_shopping', 'active_shopping'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    quotes: { type: 'array', items: { type: 'string', minLength: 1 } },
    model: { type: ['string', 'null'] },
    location: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  required: ['is_purchase_signal', 'purchase_stage', 'confidence', 'quotes'],
};

const VALID = { is_purchase_signal: true, purchase_stage: 'price_shopping', confidence: 0.82, quotes: ['优惠多少'], model: 'i3' };

const jsonReq = (extra: Record<string, unknown> = {}) => ({
  purpose: 'intent_refinement',
  system: '你是汽车购车意向分析助手，只输出 JSON。',
  prompt: '评论："现在i3优惠多少"',
  schema: SCHEMA,
  ...extra,
});

function provider(fetchImpl: typeof fetch, opts: Partial<AnthropicLlmProviderOptions> = {}) {
  const sleeps: number[] = [];
  const p = new AnthropicLlmProvider({
    apiKey: KEY,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...opts,
  });
  return { p, sleeps };
}

describe('llm/anthropic: status', () => {
  it('is AVAILABLE with a key and names the default model', () => {
    const { p } = provider(fakeFetch([]).impl);
    const s = p.status();
    assert.equal(p.name, 'anthropic');
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.status, 'AVAILABLE');
    assert.equal(s.model, 'claude-sonnet-5');
    assert.match(s.reason, /claude-sonnet-5/);
    assert.ok(!s.reason.includes(KEY));
  });

  it('is UNAVAILABLE with a blank key and never calls the API', async () => {
    const f = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const { p } = provider(f.impl, { apiKey: '   ' });
    assert.equal(p.status().status, 'UNAVAILABLE');
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, false);
    assert.equal(f.calls.length, 0);
  });
});

describe('llm/anthropic: completeJson', () => {
  it('sends a structured-output Messages API request and returns validated data', async () => {
    const f = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const { p } = provider(f.impl);
    const res = await p.completeJson<typeof VALID>(jsonReq({ max_tokens: 800 }));
    assert.deepEqual(res, { ok: true, data: VALID, model: 'claude-sonnet-5' });

    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['x-api-key'], KEY);
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.body.model, 'claude-sonnet-5');
    assert.equal(call.body.max_tokens, 800);
    assert.equal(call.body.system, '你是汽车购车意向分析助手，只输出 JSON。');
    assert.deepEqual(call.body.messages, [{ role: 'user', content: '评论："现在i3优惠多少"' }]);
    assert.equal(call.body.output_config.format.type, 'json_schema');
    const sent = call.body.output_config.format.schema;
    assert.equal(sent.additionalProperties, false);
    assert.equal(sent.properties.location.additionalProperties, false);
    assert.equal(sent.properties.confidence.minimum, undefined, 'unsupported constraints stripped');
    assert.equal(sent.properties.quotes.items.minLength, undefined);
    assert.deepEqual(sent.required, SCHEMA.required);
    assert.equal(call.body.temperature, undefined);
  });

  it('defaults max_tokens and omits a blank system prompt', async () => {
    const f = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const { p } = provider(f.impl);
    await p.completeJson(jsonReq({ system: '  ' }));
    assert.equal(f.calls[0].body.max_tokens, 16000);
    assert.equal('system' in f.calls[0].body, false);
  });

  it('rejects responses that violate the schema', async () => {
    const cases: [unknown, RegExp][] = [
      [{ ...VALID, quotes: undefined }, /missing required key "quotes"/],
      [{ ...VALID, is_purchase_signal: 'yes' }, /is_purchase_signal: expected boolean/],
      [{ ...VALID, purchase_stage: 'dreaming' }, /purchase_stage: value not in enum/],
      [{ ...VALID, confidence: 1.7 }, /confidence: must be <= 1/],
      [{ ...VALID, quotes: [''] }, /quotes\[0\]: shorter than 1/],
      [{ ...VALID, location: {} }, /location: missing required key "city"/],
      [[VALID], /\$: expected object/],
    ];
    for (const [data, pattern] of cases) {
      const f = fakeFetch([() => messageResponse(JSON.stringify(data))]);
      const res = await provider(f.impl).p.completeJson(jsonReq());
      assert.equal(res.ok, false, JSON.stringify(data));
      if (!res.ok) assert.match(res.reason, pattern);
    }
    const notJson = await provider(fakeFetch([() => messageResponse('当然可以！这是结果')]).impl).p.completeJson(jsonReq());
    assert.equal(notJson.ok, false);
    if (!notJson.ok) assert.match(notJson.reason, /not valid JSON/);
  });

  it('treats refusals and truncated output as failures', async () => {
    const refusal = fakeFetch([
      () => messageResponse('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }),
    ]);
    const r1 = await provider(refusal.impl).p.completeJson(jsonReq());
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.reason, /declined.*cyber/);

    const truncated = fakeFetch([() => messageResponse('{"is_purchase_signal": tr', { stop_reason: 'max_tokens' })]);
    const r2 = await provider(truncated.impl).p.completeJson(jsonReq());
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.reason, /truncated/);
  });
});

describe('llm/anthropic: retries', () => {
  it('retries a 429 honoring retry-after, then succeeds', async () => {
    const f = fakeFetch([
      () => apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit', { 'retry-after': '2' }),
      () => messageResponse(JSON.stringify(VALID)),
    ]);
    const { p, sleeps } = provider(f.impl);
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, true);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  it('retries 529 overloaded and 500 with exponential backoff', async () => {
    const f = fakeFetch([
      () => apiError(529, 'overloaded_error', 'Overloaded'),
      () => apiError(500, 'api_error', 'Internal server error'),
      () => messageResponse(JSON.stringify(VALID)),
    ]);
    const { p, sleeps } = provider(f.impl);
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, true);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it('applies up to 25% jitter to the backoff', async () => {
    const f = fakeFetch([() => apiError(503, 'api_error', 'unavailable'), () => messageResponse(JSON.stringify(VALID))]);
    const { p, sleeps } = provider(f.impl, { random: () => 1 });
    await p.completeJson(jsonReq());
    assert.deepEqual(sleeps, [375]);
  });

  it('gives up after maxRetries', async () => {
    const f = fakeFetch([() => apiError(503, 'api_error', 'Service unavailable')]);
    const { p, sleeps } = provider(f.impl, { maxRetries: 2 });
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, false);
    assert.equal(f.calls.length, 3);
    assert.equal(sleeps.length, 2);
    if (!res.ok) {
      assert.match(res.reason, /HTTP 503 api_error/);
      assert.match(res.reason, /after 3 attempts/);
      assert.match(res.reason, /req_011TEST/);
    }
  });

  it('never retries 400, 401 or 403', async () => {
    for (const [status, type] of [
      [400, 'invalid_request_error'],
      [401, 'authentication_error'],
      [403, 'permission_error'],
    ] as const) {
      const f = fakeFetch([() => apiError(status, type, 'nope', { 'x-should-retry': 'true' }), () => messageResponse(JSON.stringify(VALID))]);
      const { p, sleeps } = provider(f.impl);
      const res = await p.completeJson(jsonReq());
      assert.equal(res.ok, false, `status ${status}`);
      assert.equal(f.calls.length, 1, `status ${status} must not retry`);
      assert.deepEqual(sleeps, []);
      if (!res.ok) assert.match(res.reason, new RegExp(`HTTP ${status} ${type}`));
    }
  });

  it('respects x-should-retry: false and refuses retry-after beyond 60s', async () => {
    const noRetry = fakeFetch([() => apiError(500, 'api_error', 'boom', { 'x-should-retry': 'false' })]);
    const r1 = await provider(noRetry.impl).p.completeJson(jsonReq());
    assert.equal(r1.ok, false);
    assert.equal(noRetry.calls.length, 1);

    const longWait = fakeFetch([() => apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '120' })]);
    const { p, sleeps } = provider(longWait.impl);
    const r2 = await p.completeJson(jsonReq());
    assert.equal(r2.ok, false);
    assert.equal(longWait.calls.length, 1);
    assert.deepEqual(sleeps, []);
    if (!r2.ok) assert.match(r2.reason, /retry after 120s/);
  });

  it('honors retry-after-ms and HTTP-date retry-after', async () => {
    const ms = fakeFetch([() => apiError(429, 'rate_limit_error', 'x', { 'retry-after-ms': '1500' }), () => messageResponse(JSON.stringify(VALID))]);
    const a = provider(ms.impl);
    await a.p.completeJson(jsonReq());
    assert.deepEqual(a.sleeps, [1500]);

    const clock = new ManualClock('2026-09-12T02:00:00.000Z');
    const date = fakeFetch([
      () => apiError(429, 'rate_limit_error', 'x', { 'retry-after': 'Sat, 12 Sep 2026 02:00:03 GMT' }),
      () => messageResponse(JSON.stringify(VALID)),
    ]);
    const b = provider(date.impl, { clock });
    await b.p.completeJson(jsonReq());
    assert.deepEqual(b.sleeps, [3000]);
  });

  it('retries transient network errors', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => messageResponse(JSON.stringify(VALID)),
    ]);
    const { p, sleeps } = provider(f.impl);
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, true);
    assert.equal(f.calls.length, 2);
    assert.equal(sleeps.length, 1);
  });
});

describe('llm/anthropic: timeouts', () => {
  it('aborts a hung request and returns ok:false without retrying', async () => {
    const f = fakeFetch([
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
    ]);
    const { p, sleeps } = provider(f.impl, { timeoutMs: 25 });
    const started = Date.now();
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /timed out after 25ms/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.ok(Date.now() - started < 2000);
    assert.equal(f.calls[0].signal?.aborted, true);
  });

  it('times out even when the fetch implementation ignores the abort signal', async () => {
    const f = fakeFetch([() => new Promise<Response>(() => undefined)]);
    const { p } = provider(f.impl, { timeoutMs: 20 });
    const res = await p.completeText({ purpose: 'report', system: '', prompt: 'hi' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /timed out/);
  });
});

describe('llm/anthropic: completeText and configuration', () => {
  it('returns concatenated text blocks and passes effort when configured', async () => {
    const f = fakeFetch([
      () =>
        jsonResponse(200, {
          model: 'claude-opus-5',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: '您好，' },
            { type: 'text', text: '这款 i3 目前有现车。' },
          ],
          stop_reason: 'end_turn',
        }),
    ]);
    const { p } = provider(f.impl, { model: 'claude-opus-5', baseUrl: 'https://proxy.example.com/', effort: 'low' });
    const res = await p.completeText({ purpose: 'reply_draft', system: '你是销售助理', prompt: '写一句回复' });
    assert.deepEqual(res, { ok: true, data: '您好，这款 i3 目前有现车。', model: 'claude-opus-5' });
    assert.equal(f.calls[0].url, 'https://proxy.example.com/v1/messages');
    assert.equal(f.calls[0].body.model, 'claude-opus-5');
    assert.deepEqual(f.calls[0].body.output_config, { effort: 'low' });
  });

  it('omits output_config for text when no effort is set and fails on empty text', async () => {
    const f = fakeFetch([() => jsonResponse(200, { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' })]);
    const { p } = provider(f.impl);
    const res = await p.completeText({ purpose: 'reply_draft', system: 's', prompt: 'p' });
    assert.equal(res.ok, false);
    assert.equal('output_config' in f.calls[0].body, false);
  });

  it('rejects malformed success payloads', async () => {
    const f = fakeFetch([() => new Response('<html>gateway</html>', { status: 200 })]);
    const res = await provider(f.impl).p.completeText({ purpose: 'x', system: '', prompt: 'p' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /unexpected response shape/);
    assert.equal(f.calls.length, 1);
  });
});

describe('llm/anthropic: API key secrecy', () => {
  it('never includes the key in error reasons, status or serialization', async () => {
    const echo = fakeFetch([() => apiError(400, 'invalid_request_error', `invalid x-api-key header: ${KEY}`)]);
    const r1 = await provider(echo.impl).p.completeJson(jsonReq());
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.ok(!r1.reason.includes(KEY));
      assert.match(r1.reason, /\[REDACTED\]/);
    }

    const network = fakeFetch([
      () => {
        throw new Error(`connect ECONNREFUSED while sending key ${KEY}`);
      },
    ]);
    const { p } = provider(network.impl, { maxRetries: 1 });
    const r2 = await p.completeText({ purpose: 'x', system: '', prompt: 'p' });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.ok(!r2.reason.includes(KEY));

    const otherKey = 'sk-ant-api03-SOMEONE-ELSES-KEY';
    const leak = fakeFetch([() => apiError(401, 'authentication_error', `bad key ${otherKey}`)]);
    const r3 = await provider(leak.impl).p.completeJson(jsonReq());
    if (!r3.ok) assert.ok(!r3.reason.includes(otherKey));

    assert.ok(!JSON.stringify(p).includes(KEY));
    assert.ok(!JSON.stringify(p.status()).includes(KEY));
    assert.ok(!Object.values(p).some((x) => typeof x === 'string' && x.includes(KEY)));
    assert.ok(!inspect(p, { showHidden: true, depth: 10 }).includes(KEY), 'console.log / logger inspection must not leak');
  });
});

describe('llm/anthropic: request guards', () => {
  it('rejects blank prompts without calling the API', async () => {
    const f = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const { p } = provider(f.impl);
    const r1 = await p.completeText({ purpose: 'reply_draft', system: 's', prompt: '   ' });
    const r2 = await p.completeJson(jsonReq({ prompt: '' }));
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    if (!r1.ok) assert.match(r1.reason, /prompt is empty/);
    assert.equal(f.calls.length, 0);
  });

  it('refuses free-form map schemas that structured outputs would silently reduce to {}', async () => {
    const f = fakeFetch([() => messageResponse(JSON.stringify({ slots: {} }))]);
    const { p } = provider(f.impl);
    const res = await p.completeJson(
      jsonReq({ schema: { type: 'object', properties: { slots: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['slots'] } }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /\$\.slots: free-form object/);
    assert.equal(f.calls.length, 0);
    assert.equal(structuredOutputSchemaIssue(SCHEMA), null);
    assert.equal(structuredOutputSchemaIssue({ type: 'object', properties: {}, additionalProperties: false }), null, 'explicit empty object');
    assert.match(
      structuredOutputSchemaIssue({ type: 'object', properties: { list: { type: 'array', items: { type: 'object' } } } }) ?? '',
      /\$\.list\[\]/,
    );
    assert.match(structuredOutputSchemaIssue({ type: 'object', $defs: { m: { type: 'object' } }, properties: { a: { type: 'string' } } }) ?? '', /#\/\$defs\/m/);
  });

  it('rejects keys outside additionalProperties:false and validates typed additionalProperties', () => {
    const closed = { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false };
    assert.deepEqual(validateJsonSchema({ a: 1 }, closed), []);
    assert.deepEqual(validateJsonSchema({ a: 1, b: 2 }, closed), ['$: unexpected key "b"']);
    const typed = { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: { type: 'string' } };
    assert.deepEqual(validateJsonSchema({ a: 1, b: 'x' }, typed), []);
    assert.equal(validateJsonSchema({ a: 1, b: 2 }, typed).length, 1);
  });

  it('returns ok:false when a structured response carries unexpected keys', async () => {
    const schema = { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false };
    const f = fakeFetch([() => messageResponse(JSON.stringify({ stage: 'research', invented_budget: 300000 }))]);
    const res = await provider(f.impl).p.completeJson(jsonReq({ schema }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /unexpected key "invented_budget"/);
  });

  it('checks both anyOf and oneOf when a node declares both', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'integer' }], oneOf: [{ type: 'integer' }] };
    assert.deepEqual(validateJsonSchema(3, schema), []);
    assert.equal(validateJsonSchema('x', schema).length, 1);
  });

  it('strips string formats that structured outputs do not support and keeps supported ones', () => {
    const out = toStructuredOutputSchema({
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' }, re: { type: 'string', format: 'regex' }, format: { type: 'string' } },
    }) as any;
    assert.equal(out.properties.at.format, 'date-time');
    assert.equal('format' in out.properties.re, false);
    assert.deepEqual(out.properties.format, { type: 'string' }, 'a property literally named "format" is preserved');
  });
});

describe('llm/anthropic: server-side refusal fallbacks', () => {
  it('requests fallbacks:"default" with the beta header for claude-opus-5 but not for the default model', async () => {
    const opus = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const a = provider(opus.impl, { model: 'claude-opus-5' });
    assert.equal(a.p.refusalFallbacks, true);
    assert.match(a.p.status().reason, /refusal fallbacks on/);
    await a.p.completeJson(jsonReq());
    assert.equal(opus.calls[0].body.fallbacks, 'default');
    assert.equal(opus.calls[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(opus.calls[0].headers['x-api-key'], KEY);

    const sonnet = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const b = provider(sonnet.impl);
    assert.equal(b.p.refusalFallbacks, false);
    await b.p.completeText({ purpose: 'x', system: '', prompt: 'p' });
    assert.equal('fallbacks' in sonnet.calls[0].body, false);
    assert.equal(sonnet.calls[0].headers['anthropic-beta'], undefined);

    const off = fakeFetch([() => messageResponse(JSON.stringify(VALID))]);
    const c = provider(off.impl, { model: 'claude-fable-5-1', refusalFallbacks: false });
    await c.p.completeJson(jsonReq());
    assert.equal('fallbacks' in off.calls[0].body, false);
  });

  it('resends once without fallbacks when the endpoint rejects them and stops requesting them', async () => {
    const f = fakeFetch([
      () => apiError(400, 'invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.'),
      () => messageResponse(JSON.stringify(VALID)),
    ]);
    const { p, sleeps } = provider(f.impl, { model: 'claude-opus-5' });
    const res = await p.completeJson(jsonReq());
    assert.equal(res.ok, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].body.fallbacks, undefined);
    assert.equal(f.calls[1].headers['anthropic-beta'], undefined);
    assert.deepEqual(sleeps, [], 'not a backoff retry');
    await p.completeJson(jsonReq());
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].body.fallbacks, undefined, 'fallbacks remain off for this provider');
    assert.doesNotMatch(p.status().reason, /refusal fallbacks on/);
  });

  it('does not strip fallbacks for unrelated 400s', async () => {
    const f = fakeFetch([() => apiError(400, 'invalid_request_error', 'max_tokens: must be positive')]);
    const res = await provider(f.impl, { model: 'claude-opus-5' }).p.completeJson(jsonReq());
    assert.equal(res.ok, false);
    assert.equal(f.calls.length, 1);
  });

  it('returns the served fallback model and ignores fallback marker blocks', async () => {
    const f = fakeFetch([
      () =>
        jsonResponse(200, {
          model: 'claude-opus-4-8',
          content: [
            { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
            { type: 'text', text: JSON.stringify(VALID) },
          ],
          stop_reason: 'end_turn',
          usage: { iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
        }),
    ]);
    const res = await provider(f.impl, { model: 'claude-opus-5' }).p.completeJson(jsonReq());
    assert.deepEqual(res, { ok: true, data: VALID, model: 'claude-opus-4-8' });
  });

  it('can be disabled from the environment', () => {
    const p = createLlmProvider({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: 'claude-opus-5', ANTHROPIC_REFUSAL_FALLBACKS: 'off' });
    assert.ok(p instanceof AnthropicLlmProvider);
    assert.equal(p.refusalFallbacks, false);
    const on = createLlmProvider({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: 'claude-opus-5' });
    assert.ok(on instanceof AnthropicLlmProvider);
    assert.equal(on.refusalFallbacks, true);
  });
});

describe('llm: createLlmProvider', () => {
  it('returns the disabled provider without a key', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const p = createLlmProvider(env);
      assert.ok(p instanceof DisabledLlmProvider);
      assert.equal(p.status().status, 'UNAVAILABLE');
    }
  });

  it('builds an Anthropic provider from env with model and base URL overrides', () => {
    const p = createLlmProvider({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: 'claude-opus-5', ANTHROPIC_BASE_URL: 'https://gw.example.com/anthropic/' });
    assert.ok(p instanceof AnthropicLlmProvider);
    assert.equal(p.status().status, 'AVAILABLE');
    assert.equal(p.status().model, 'claude-opus-5');
    assert.equal(p.baseUrl, 'https://gw.example.com/anthropic');

    const defaults = createLlmProvider({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: '' });
    assert.ok(defaults instanceof AnthropicLlmProvider);
    assert.equal(defaults.model, 'claude-sonnet-5');
    assert.equal(defaults.baseUrl, 'https://api.anthropic.com');
  });
});

describe('llm/anthropic: schema helpers', () => {
  it('adapts schemas for structured outputs without mutating the input', () => {
    const input = {
      type: 'object',
      properties: {
        items: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', properties: { q: { type: 'string', pattern: '^a' } } } },
        choice: { oneOf: [{ type: 'string' }, { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: true }] },
      },
      $defs: { ref: { type: 'object', properties: { y: { type: 'integer', multipleOf: 2 } } } },
    };
    const snapshot = JSON.stringify(input);
    const out = toStructuredOutputSchema(input) as any;
    assert.equal(JSON.stringify(input), snapshot);
    assert.equal(out.additionalProperties, false);
    assert.equal(out.properties.items.minItems, undefined);
    assert.equal(out.properties.items.maxItems, undefined);
    assert.equal(out.properties.items.items.additionalProperties, false);
    assert.equal(out.properties.items.items.properties.q.pattern, undefined);
    assert.equal(out.properties.choice.oneOf, undefined);
    assert.equal(out.properties.choice.anyOf[1].additionalProperties, false);
    assert.equal(out.$defs.ref.additionalProperties, false);
    assert.equal(out.$defs.ref.properties.y.multipleOf, undefined);
  });

  it('validates $ref, anyOf, integer and null unions', () => {
    const schema = {
      type: 'object',
      properties: {
        stage: { $ref: '#/$defs/stage' },
        budget: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
      required: ['stage', 'budget'],
      $defs: { stage: { type: 'string', enum: ['research', 'comparison'] } },
    };
    assert.deepEqual(validateJsonSchema({ stage: 'research', budget: 250000 }, schema), []);
    assert.deepEqual(validateJsonSchema({ stage: 'research', budget: null }, schema), []);
    assert.equal(validateJsonSchema({ stage: 'unknown', budget: null }, schema).length, 1);
    assert.equal(validateJsonSchema({ stage: 'research', budget: 2.5 }, schema).length, 1);
    assert.deepEqual(validateJsonSchema(3, { type: 'number' }), []);
  });
});
