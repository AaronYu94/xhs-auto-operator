import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnthropicLlmProvider, toStructuredOutputSchema } from '../../../src/providers/llm/anthropic.ts';
import { createLlmProvider } from '../../../src/providers/llm/index.ts';
import { OPENROUTER_DEFAULT_MODEL, OpenRouterLlmProvider, openRouterModelId } from '../../../src/providers/llm/openrouter.ts';
import { DisabledLlmProvider } from '../../../src/providers/llm/types.ts';

const KEY = 'sk-or-v1-TEST-SECRET-0123456789abcdef';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(replies: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const completion = (content: string, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ model: 'anthropic/claude-sonnet-5', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content }, ...extra }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, stage: { type: ['string', 'null'], enum: ['research', 'active_shopping', null] } },
  required: ['city', 'stage'],
};

function provider(replies: (() => Response)[], opts: Partial<ConstructorParameters<typeof OpenRouterLlmProvider>[0]> = {}) {
  const net = fakeFetch(replies);
  const sleeps: number[] = [];
  const p = new OpenRouterLlmProvider({ apiKey: KEY, fetchImpl: net.fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, ...opts });
  return { p, calls: net.calls, sleeps };
}

describe('llm/openrouter', () => {
  it('JSON: sends a strict json_schema chat completion routed only to providers that honour it, and validates the answer', async () => {
    const { p, calls } = provider([completion('{"city":"舟山","stage":"active_shopping"}')]);
    const res = await p.completeJson<{ city: string }>({ purpose: 'intent_refinement', system: '抽取', prompt: '我在舟山', schema: SCHEMA, max_tokens: 300 });
    assert.deepEqual(res, { ok: true, data: { city: '舟山', stage: 'active_shopping' }, model: 'anthropic/claude-sonnet-5' });
    const call = calls[0]!;
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.body.model, OPENROUTER_DEFAULT_MODEL);
    assert.equal(call.body.max_tokens, 300);
    assert.deepEqual(call.body.messages, [
      { role: 'system', content: '抽取' },
      { role: 'user', content: '我在舟山' },
    ]);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.equal(call.body.response_format.json_schema.name, 'intent_refinement');
    assert.deepEqual(call.body.provider, { require_parameters: true });
    assert.equal(call.body.response_format.json_schema.schema.additionalProperties, false);
  });

  it('JSON: fenced output is accepted; invalid JSON and schema violations are failures, never data', async () => {
    const fenced = await provider([completion('```json\n{"city":"杭州","stage":null}\n```')]).p.completeJson({ purpose: 'x', system: '', prompt: '', schema: SCHEMA });
    assert.ok(fenced.ok);
    const bad = await provider([completion('不是 JSON')]).p.completeJson({ purpose: 'x', system: '', prompt: '', schema: SCHEMA });
    assert.deepEqual(bad, { ok: false, reason: 'x: model returned invalid JSON' });
    const wrong = await provider([completion('{"city":1,"stage":"buy_now"}')]).p.completeJson({ purpose: 'x', system: '', prompt: '', schema: SCHEMA });
    assert.ok(!wrong.ok && /failed schema validation/.test(wrong.reason));
  });

  it('text: returns the trimmed completion; truncated, filtered, refused or empty answers fail', async () => {
    const ok = await provider([completion('  您好  ')]).p.completeText({ purpose: 'outreach_refinement', system: 's', prompt: 'p' });
    assert.deepEqual(ok, { ok: true, data: '您好', model: 'anthropic/claude-sonnet-5' });
    const cases: [() => Response, RegExp][] = [
      [completion('半句', { finish_reason: 'length' }), /truncated/],
      [completion('x', { finish_reason: 'content_filter' }), /content filter/],
      [() => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: '不能回答' } }] }), { status: 200 }), /refused/],
      [completion('   '), /empty completion/],
    ];
    for (const [reply, re] of cases) {
      const res = await provider([reply]).p.completeText({ purpose: 't', system: '', prompt: '' });
      assert.ok(!res.ok && re.test(res.reason), res.ok ? 'unexpected ok' : res.reason);
    }
  });

  it('retries 429 / 5xx honouring retry-after, never 400 / 401 / 402, and never leaks the key', async () => {
    const retried = provider([failure(429, { error: { code: 429, message: 'rate limited' } }, { 'retry-after': '2' }), failure(502, { error: { code: 502, message: 'bad gateway' } }), completion('好')]);
    const ok = await retried.p.completeText({ purpose: 't', system: '', prompt: '' });
    assert.ok(ok.ok);
    assert.equal(retried.calls.length, 3);
    assert.deepEqual(retried.sleeps, [2000, 1000], 'retry-after first, then exponential backoff');

    for (const status of [400, 401, 402]) {
      const once = provider([failure(status, { error: { code: status, message: `bad key ${KEY}` } })]);
      const res = await once.p.completeText({ purpose: 't', system: '', prompt: '' });
      assert.ok(!res.ok);
      assert.equal(once.calls.length, 1, `HTTP ${status} is not retried`);
      if (!res.ok) {
        assert.doesNotMatch(res.reason, /sk-or-v1-TEST/, 'the key is redacted');
        assert.match(res.reason, new RegExp(`HTTP ${status}`));
      }
    }
    const exhausted = provider([failure(503, {}), failure(503, {}), failure(503, {})], { maxRetries: 2 });
    assert.ok(!(await exhausted.p.completeText({ purpose: 't', system: '', prompt: '' })).ok);
    assert.equal(exhausted.calls.length, 3);
  });

  it('surfaces the upstream provider error hidden behind "Provider returned error"', async () => {
    const raw = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid schema: Enum value does not match' } });
    const res = await provider([failure(400, { error: { code: 400, message: 'Provider returned error', metadata: { raw, provider_name: 'Anthropic' } } })]).p.completeJson({
      purpose: 'x',
      system: '',
      prompt: '',
      schema: SCHEMA,
    });
    assert.ok(!res.ok);
    if (!res.ok) assert.match(res.reason, /HTTP 400: Provider returned error \(Anthropic: Invalid schema: Enum value does not match\)/);
  });

  it('a network failure is retried; a timeout is not', async () => {
    let n = 0;
    const flaky = new OpenRouterLlmProvider({
      apiKey: KEY,
      sleep: async () => {},
      fetchImpl: (async () => {
        if (n++ === 0) throw new TypeError('fetch failed');
        return completion('好')();
      }) as typeof fetch,
    });
    assert.ok((await flaky.completeText({ purpose: 't', system: '', prompt: '' })).ok);
    const slow = new OpenRouterLlmProvider({
      apiKey: KEY,
      timeoutMs: 10,
      fetchImpl: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch,
    });
    const res = await slow.completeText({ purpose: 't', system: '', prompt: '' });
    assert.ok(!res.ok && /timed out after 10 ms/.test(res.reason));
  });

  it('model ids: OpenRouter ids pass through, bare Anthropic ids are mapped', () => {
    assert.equal(openRouterModelId(undefined), 'anthropic/claude-sonnet-5');
    assert.equal(openRouterModelId('openai/gpt-x'), 'openai/gpt-x');
    assert.equal(openRouterModelId('claude-opus-5'), 'anthropic/claude-opus-5');
    assert.equal(openRouterModelId('claude-fable-5-1'), 'anthropic/claude-fable-5.1');
  });
});

describe('llm: structured-output schema adaptation', () => {
  it('rewrites a union type with an enum as anyOf branches (structured outputs reject enum next to a type union)', () => {
    assert.deepEqual(toStructuredOutputSchema(SCHEMA).properties, {
      city: { type: 'string' },
      stage: { anyOf: [{ type: 'string', enum: ['research', 'active_shopping'] }, { type: 'null' }] },
    });
    assert.deepEqual(toStructuredOutputSchema({ type: 'string', enum: ['a'] }), { type: 'string', enum: ['a'] }, 'single types are untouched');
  });
});

describe('llm: createLlmProvider selection', () => {
  it('OPENROUTER_API_KEY selects OpenRouter; LLM_PROVIDER picks explicitly; none / missing keys disable honestly', () => {
    const or = createLlmProvider({ OPENROUTER_API_KEY: KEY, LLM_MODEL: 'claude-opus-5' });
    assert.ok(or instanceof OpenRouterLlmProvider);
    assert.equal(or.status().model, 'anthropic/claude-opus-5');
    assert.ok(createLlmProvider({ OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-x' }) instanceof OpenRouterLlmProvider, 'OpenRouter wins when both keys exist');
    assert.ok(createLlmProvider({ LLM_PROVIDER: 'anthropic', OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-x' }) instanceof AnthropicLlmProvider);
    const none = createLlmProvider({ LLM_PROVIDER: 'none', OPENROUTER_API_KEY: KEY });
    assert.ok(none instanceof DisabledLlmProvider && /LLM_PROVIDER=none/.test(none.status().reason));
    const missing = createLlmProvider({ LLM_PROVIDER: 'openrouter' });
    assert.ok(missing instanceof DisabledLlmProvider && /OPENROUTER_API_KEY is not set/.test(missing.status().reason));
    assert.doesNotMatch(JSON.stringify(or.status()), /sk-or-v1/, 'status never exposes the key');
  });
});
