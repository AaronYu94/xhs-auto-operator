import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { AppError, NotFoundError, PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { Router, parseJsonBody, queryEnum, queryInt, readRawBody, toErrorReply } from '../../../src/server/http.ts';
import { dataBody, esc, href, outreachStatusPill, pill, sourceLink } from '../../../src/server/render.ts';

const ok = () => ({ json: {} });

describe('server http: router', () => {
  it('prefers static segments over params and decodes params', () => {
    const r = new Router().get('/api/leads/:id', ok).get('/api/leads/queue', ok).post('/api/leads/:id/assign', ok);
    const a = r.match('GET', '/api/leads/queue');
    assert.equal(a.kind, 'found');
    assert.equal(a.kind === 'found' && a.route.pattern, '/api/leads/queue');
    const b = r.match('GET', '/api/leads/lead_%E4%B8%AD');
    assert.equal(b.kind === 'found' && b.params.id, 'lead_中');
    assert.equal(r.match('HEAD', '/api/leads/x').kind, 'found', 'HEAD matches GET');
  });

  it('reports 405 with allowed methods, 404 otherwise, and rejects malformed encoding', () => {
    const r = new Router().get('/api/leads/:id', ok).post('/api/leads/:id/assign', ok);
    const m = r.match('DELETE', '/api/leads/x');
    assert.deepEqual(m, { kind: 'method_not_allowed', allowed: ['GET'] });
    assert.equal(r.match('GET', '/nope').kind, 'not_found');
    assert.throws(() => r.match('GET', '/api/leads/%E0%A4%A'), (err: unknown) => err instanceof AppError && err.status === 400);
    assert.throws(() => r.get('/api/leads/:other', ok), /duplicate route/);
  });
});

describe('server http: bodies and errors', () => {
  it('reads bodies within the limit and rejects oversized ones with 413', async () => {
    const small = new PassThrough();
    const p = readRawBody(small as unknown as IncomingMessage, 16);
    small.end(Buffer.from('{"a":1}'));
    assert.equal((await p).toString(), '{"a":1}');

    const big = new PassThrough();
    const q = readRawBody(big as unknown as IncomingMessage, 8);
    big.end(Buffer.from('0123456789'));
    await assert.rejects(q, (err: unknown) => err instanceof AppError && err.status === 413);

    const declared = Object.assign(new PassThrough(), { headers: { 'content-length': '999' } });
    await assert.rejects(readRawBody(declared as unknown as IncomingMessage, 8), (err: unknown) => err instanceof AppError && err.status === 413);
  });

  it('parses JSON bodies (empty → {}) and maps invalid JSON to 400', () => {
    assert.deepEqual(parseJsonBody(Buffer.from('  ')), {});
    assert.deepEqual(parseJsonBody(Buffer.from('{"x":[1]}')), { x: [1] });
    assert.throws(() => parseJsonBody(Buffer.from('{bad')), (err: unknown) => err instanceof AppError && err.code === 'invalid_json');
  });

  it('maps AppErrors to their status and hides unexpected errors', () => {
    const nf = toErrorReply(new NotFoundError('lead', 'x'));
    assert.equal(nf.reply.status, 404);
    assert.equal(nf.internal, false);
    assert.deepEqual((nf.reply.json as { error: { code: string } }).error.code, 'not_found');
    assert.equal(toErrorReply(new ValidationError('a', 'b')).reply.status, 422);
    assert.equal(toErrorReply(new PolicyError('suppressed', 'no')).reply.status, 409);
    const boom = toErrorReply(new Error('secret stack detail'));
    assert.equal(boom.reply.status, 500);
    assert.equal(boom.internal, true);
    assert.doesNotMatch(JSON.stringify(boom.reply.json), /secret stack detail/);
  });

  it('validates query parameters', () => {
    const q = new URLSearchParams('limit=20&tier=qualified&bad=1.5');
    assert.equal(queryInt(q, 'limit', { min: 1, max: 500 }), 20);
    assert.equal(queryInt(q, 'missing'), undefined);
    assert.throws(() => queryInt(q, 'bad'), (err: unknown) => err instanceof AppError && err.status === 422);
    assert.equal(queryEnum(q, 'tier', ['qualified', 'candidate'] as const), 'qualified');
    assert.throws(() => queryEnum(q, 'tier', ['none'] as const));
  });
});

describe('server render: escaping and honest labels', () => {
  it('escapes content in pills, attributes and data bodies', () => {
    assert.equal(esc('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
    assert.equal(esc(null), '');
    assert.doesNotMatch(pill('<b>', 'green', '"x"'), /<b>|"x"/);
    assert.doesNotMatch(dataBody({ text: '"><script>' }), /<script>|"/);
    assert.equal(href('/leads', { dealer: 'd1', q: '', tier: undefined }), '/leads?dealer=d1');
  });

  it('only links https xiaohongshu sources', () => {
    assert.match(sourceLink('https://www.xiaohongshu.com/explore/abc?xsec_token=t'), /href="https:\/\/www\.xiaohongshu\.com\/explore\/abc\?xsec_token=t"/);
    assert.doesNotMatch(sourceLink('javascript:alert(1)'), /href=/);
    assert.doesNotMatch(sourceLink('https://evil.example/xiaohongshu.com'), /href=/);
    assert.match(sourceLink(null), /无原帖链接/);
  });

  it('never labels an unconfirmed outreach as sent', () => {
    assert.match(outreachStatusPill('APPROVED', false), /待人工发送/);
    assert.match(outreachStatusPill('SENT_MANUALLY'), /人工发送/);
    assert.doesNotMatch(outreachStatusPill('READY_FOR_REVIEW'), /发送成功/);
  });
});
