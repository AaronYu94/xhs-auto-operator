import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerMediaRoutes, xhsImageSrc, xhsImageUrl } from '../../../src/server/api/media.ts';
import { Router, type Reply, type RequestContext } from '../../../src/server/http.ts';

const AVATAR = 'https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo';

function proxy(fetchImpl: typeof fetch) {
  const router = new Router();
  registerMediaRoutes(router, { fetchImpl });
  const m = router.match('GET', '/media/xhs-image');
  assert.equal(m.kind, 'found');
  assert.equal(m.kind === 'found' && m.route.opts.public, undefined, 'images need a console session like every page');
  return (src: string) =>
    (m.kind === 'found' ? m.route.handler({ query: new URLSearchParams({ src }) } as unknown as RequestContext) : null) as Promise<Reply>;
}

describe('xiaohongshu image proxy', () => {
  it('only Xiaohongshu CDN images, upgraded to https; everything else is refused', () => {
    assert.equal(xhsImageUrl('http://sns-webpic-qc.xhscdn.com/202609200040/abc/no')?.href, 'https://sns-webpic-qc.xhscdn.com/202609200040/abc/no');
    assert.equal(xhsImageUrl(AVATAR)?.href, AVATAR);
    for (const bad of [
      'https://xhscdn.com.evil.example/a.jpg',
      'https://evilxhscdn.com/a.jpg',
      'https://127.0.0.1/a.jpg',
      'file:///etc/passwd',
      'https://user:pw@sns-avatar-qc.xhscdn.com/a',
      'https://sns-avatar-qc.xhscdn.com:8443/a',
      'not a url',
      '',
    ]) {
      assert.equal(xhsImageUrl(bad), null, bad);
    }
    assert.equal(xhsImageSrc(AVATAR), `/media/xhs-image?src=${encodeURIComponent(AVATAR)}`);
    assert.equal(xhsImageSrc('https://example.com/a.jpg'), null);
    assert.equal(xhsImageSrc(null), null);
  });

  it('serves the image privately, caches it, and refuses redirects, non-images and oversized bodies', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let next: () => Response = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const get = proxy((async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return next();
    }) as typeof fetch);

    const ok = await get(AVATAR);
    assert.equal(ok.contentType, 'image/jpeg');
    assert.deepEqual([...(ok.body as Buffer)], [1, 2, 3]);
    assert.equal(ok.headers?.['cache-control'], 'private, max-age=3600');
    assert.equal(calls[0]?.init?.redirect, 'manual', 'redirects are never followed');
    await get(AVATAR);
    assert.equal(calls.length, 1, 'served from cache');

    assert.equal((await get('https://example.com/x.jpg')).status, 400);
    assert.equal(calls.length, 1, 'a refused URL is never fetched');

    next = () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
    assert.equal((await get(`${AVATAR}?r`)).status, 502);
    next = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    assert.equal((await get(`${AVATAR}?html`)).status, 502);
    next = () => new Response(new Uint8Array(3 * 1024 * 1024), { status: 200, headers: { 'content-type': 'image/png' } });
    assert.equal((await get(`${AVATAR}?big`)).status, 502);
    next = () => {
      throw new TypeError('fetch failed');
    };
    assert.equal((await get(`${AVATAR}?down`)).status, 502);
  });
});
