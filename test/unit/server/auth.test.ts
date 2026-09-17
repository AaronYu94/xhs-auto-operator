import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  clientAddress,
  isCsrfSafe,
  normalizeOperatorName,
  parseCookies,
  safeEqual,
  sessionCookie,
  signSession,
  verifySession,
} from '../../../src/server/auth.ts';

const SECRET = 'test-secret-0123456789abcdef';
const NOW = Date.parse('2026-09-12T02:00:00.000Z');

describe('server auth: session tokens', () => {
  it('round-trips a signed session until it expires', () => {
    const token = signSession(SECRET, { sub: '王磊', exp: NOW + 60_000 });
    assert.deepEqual(verifySession(SECRET, token, NOW), { sub: '王磊', exp: NOW + 60_000 });
    assert.equal(verifySession(SECRET, token, NOW + 60_000), null, 'expired exactly at exp');
  });

  it('rejects tampered payloads, foreign secrets and malformed tokens', () => {
    const token = signSession(SECRET, { sub: 'alice', exp: NOW + 60_000 });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: NOW + 9e9 })).toString('base64url');
    assert.equal(verifySession(SECRET, `${forged}.${sig}`, NOW), null);
    assert.equal(verifySession('other-secret', token, NOW), null);
    for (const bad of ['', 'abc', `${body}.`, `.${sig}`, `${body}.${sig}.x`, `${body}.!!!`]) {
      assert.equal(verifySession(SECRET, bad, NOW), null, bad);
    }
    assert.equal(verifySession('', token, NOW), null, 'empty secret never verifies');
    assert.throws(() => signSession('', { sub: 'x', exp: NOW }));
  });

  it('normalizes operator names (no markup, bounded length)', () => {
    assert.equal(normalizeOperatorName('  王  磊 '), '王 磊');
    assert.equal(normalizeOperatorName('<script>x</script>'), 'scriptx/script');
    assert.equal(normalizeOperatorName(''), null);
    assert.equal(normalizeOperatorName(42), null);
    assert.equal(Array.from(normalizeOperatorName('名'.repeat(80)) ?? '').length, 40);
  });

  it('safeEqual compares by value regardless of length', () => {
    assert.equal(safeEqual('pass', 'pass'), true);
    assert.equal(safeEqual('pass', 'pass2'), false);
    assert.equal(safeEqual('', ''), true);
  });
});

describe('server auth: cookies and CSRF', () => {
  it('parses cookies (first wins, tolerates bad encoding) and serializes hardened session cookies', () => {
    const cookies = parseCookies(`a=1; ${SESSION_COOKIE}=x%2Ey; a=2; broken=%E0%A4%A`);
    assert.equal(cookies.a, '1');
    assert.equal(cookies[SESSION_COOKIE], 'x.y');
    assert.equal(cookies.broken, '%E0%A4%A');
    const c = sessionCookie('tok', { secure: true });
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Secure/);
    assert.match(c, /Max-Age=43200/);
    assert.doesNotMatch(sessionCookie('tok', { secure: false }), /Secure/);
    assert.match(clearSessionCookie(false), /Max-Age=0/);
  });

  it('requires the console header or a same-origin Origin for state-changing requests', () => {
    assert.equal(isCsrfSafe({ method: 'GET', headers: {} }), true);
    assert.equal(isCsrfSafe({ method: 'POST', headers: {} }), false);
    assert.equal(isCsrfSafe({ method: 'POST', headers: { 'x-console-request': '1' } }), true);
    assert.equal(isCsrfSafe({ method: 'PATCH', headers: { origin: 'http://localhost:8080', host: 'localhost:8080' } }), true);
    assert.equal(isCsrfSafe({ method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost:8080' } }), false);
    assert.equal(isCsrfSafe({ method: 'DELETE', headers: { origin: 'null', host: 'localhost:8080' } }), false);
    assert.equal(isCsrfSafe({ method: 'POST', headers: { origin: 'not a url', host: 'localhost:8080' } }), false);
    // regression: a real browser <form> login POST (found in live console inspection) sends Sec-Fetch-Site and may
    // send Origin: null under a strict referrer policy — it must pass; cross-site fetch metadata must never pass.
    assert.equal(isCsrfSafe({ method: 'POST', headers: { origin: 'null', host: '127.0.0.1:4173', 'sec-fetch-site': 'same-origin' } }), true);
    assert.equal(isCsrfSafe({ method: 'POST', headers: { origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site' } }), false);
    assert.equal(isCsrfSafe({ method: 'POST', headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'same-site' } }), false);
  });
});

describe('server auth: client address behind a reverse proxy', () => {
  const req = (remoteAddress: string, xff?: string | string[]) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': xff } });

  it('uses the socket address unless the proxy is trusted', () => {
    assert.equal(clientAddress(req('127.0.0.1', '203.0.113.9'), false), '127.0.0.1');
    assert.equal(clientAddress(req('198.51.100.4', '203.0.113.9'), false), '198.51.100.4');
  });

  it('takes the last X-Forwarded-For entry from a loopback proxy', () => {
    assert.equal(clientAddress(req('127.0.0.1', '203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientAddress(req('::ffff:127.0.0.1', 'forged, 203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientAddress(req('::1', ['10.0.0.1', '203.0.113.9']), true), '203.0.113.9');
    assert.equal(clientAddress(req('127.0.0.1'), true), '127.0.0.1');
  });

  it('ignores X-Forwarded-For from non-loopback peers even when trusted', () => {
    assert.equal(clientAddress(req('198.51.100.4', '203.0.113.9'), true), '198.51.100.4');
  });
});
