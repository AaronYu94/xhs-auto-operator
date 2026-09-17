/**
 * LIVE verification against a real xiaohongshu-mcp instance (never mocked).
 *
 *   XHS_LIVE_MCP_URL=http://127.0.0.1:18060/mcp XHS_LIVE_MCP_TOKEN_FILE=~/xhs-mcp-data/token \
 *     node --test test/live/xhs-live.test.ts
 *
 * Skipped unless XHS_LIVE_MCP_URL is set. Logged out: asserts the provider reports REQUIRES_AUTH (not an empty success).
 * Logged in: runs a real public search, reads the first note and its comments and asserts real ids / URLs.
 * Every tool call launches a headless browser on the instance — expect minutes, not seconds.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';
import { SystemClock } from '../../src/core/clock.ts';
import { McpXhsProvider } from '../../src/providers/xhs/mcp-provider.ts';

const LIVE_URL = process.env.XHS_LIVE_MCP_URL?.trim();
const QUERY = process.env.XHS_LIVE_QUERY?.trim() || '买车';

function liveToken(): string | undefined {
  const direct = process.env.XHS_LIVE_MCP_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.XHS_LIVE_MCP_TOKEN_FILE?.trim();
  if (!file) return undefined;
  return readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8').trim() || undefined;
}

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(`[xhs-live] ${msg} ${JSON.stringify(data)}`);

describe('live xiaohongshu-mcp', { skip: LIVE_URL ? false : 'set XHS_LIVE_MCP_URL to verify against a real instance' }, () => {
  it('reports the real session honestly and, when logged in, reads real public posts and comments', { timeout: 20 * 60_000 }, async () => {
    const provider = new McpXhsProvider(new SystemClock(), { research_endpoint: { url: LIVE_URL!, token: liveToken() }, account_endpoints: {}, timeout_ms: 180_000 });

    const status = await provider.auth.status(null);
    assert.ok(status.ok, `login probe failed: ${!status.ok ? `${status.status}: ${status.reason}` : ''}`);
    log('login status', { logged_in: status.data.logged_in, username: status.data.username, platform_user_id: status.data.platform_user_id, detail: status.data.detail });

    const caps = await provider.capabilities(null);
    const search = caps.capabilities.search_public_content;
    log('capability search_public_content', { status: search.status, reason: search.reason });

    if (!status.data.logged_in) {
      assert.equal(search.status, 'REQUIRES_AUTH');
      const res = await provider.searchNotes(QUERY, { limit: 5 });
      assert.equal(res.ok, false, 'a logged-out session must never produce search results or an empty success');
      if (!res.ok) {
        assert.equal(res.status, 'REQUIRES_AUTH', res.reason);
        log('search blocked (logged out)', { status: res.status, reason: res.reason });
      }
      return;
    }

    assert.equal(search.status, 'AVAILABLE', search.reason);
    const found = await provider.searchNotes(QUERY, { limit: 10, sort: 'general' });
    assert.ok(found.ok, `search failed: ${!found.ok ? `${found.status}: ${found.reason}` : ''}`);
    assert.ok(found.data.length > 0, `real search for "${QUERY}" returned no notes`);
    for (const n of found.data) {
      assert.match(n.platform_post_id, /^[0-9a-z]{16,32}$/i, 'real Xiaohongshu note id');
      assert.ok(n.xsec_token, 'search results carry the xsec_token needed for detail reads');
      assert.equal(n.url, `https://www.xiaohongshu.com/explore/${n.platform_post_id}?xsec_token=${encodeURIComponent(n.xsec_token!)}`);
    }
    log('search results', { count: found.data.length, first: found.data.slice(0, 3).map((n) => ({ id: n.platform_post_id, title: n.title, author: n.author.nickname, url: n.url })) });

    const first = found.data[0];
    const note = await provider.getNote({ platform_post_id: first.platform_post_id, xsec_token: first.xsec_token });
    assert.ok(note.ok, `note detail failed: ${!note.ok ? `${note.status}: ${note.reason}` : ''}`);
    assert.equal(note.data.platform_post_id, first.platform_post_id);
    assert.ok(note.data.title || note.data.content, 'real note has a title or body');
    log('note', { id: note.data.platform_post_id, title: note.data.title, published_at: note.data.published_at, ip_location: note.data.ip_location, comment_count: note.data.comment_count });

    const comments = await provider.getComments({ platform_post_id: first.platform_post_id, xsec_token: first.xsec_token }, { include_replies: true, limit: 20 });
    assert.ok(comments.ok, `comments failed: ${!comments.ok ? `${comments.status}: ${comments.reason}` : ''}`);
    for (const c of comments.data) {
      assert.ok(c.platform_comment_id, 'real comment id');
      assert.ok(c.author.platform_user_id, 'comment author id');
      assert.equal(c.author.profile_url, `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(c.author.platform_user_id!)}`);
    }
    log('comments', { count: comments.data.length, sample: comments.data.slice(0, 5).map((c) => ({ id: c.platform_comment_id, author: c.author.nickname, content: c.content })) });
  });
});
