import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { reviewPost, approvePost } from '../../../src/skills/content/content-review/index.ts';
import { generatePost } from '../../../src/skills/content/post-generation/index.ts';
import {
  NO_IMAGE_REASON,
  UNKNOWN_OUTCOME_REASON,
  collectPerformance,
  markPublishedManually,
  parseNoteIdFromUrl,
  publishDuePosts,
  recordPostMetrics,
  requeuePost,
  setPostImages,
  setPostVideo,
} from '../../../src/skills/content/publishing/index.ts';
import { insertPost, setupContent, withOverrides } from './helpers.ts';

type Setup = ReturnType<typeof setupContent>;

async function scheduledPost(s: Setup, account = 'xhs-hz-sales-wang', pillar: 'price_offer' | 'model_review' = 'model_review', model = 'X3') {
  // a past slot → scheduled_for = now, so the post is due immediately
  const p = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc(account), pillar, model, slot_date: '2026-09-11' });
  await generatePost(s.ctx, p.id);
  reviewPost(s.ctx, p.id);
  return approvePost(s.ctx, p.id, 'operator:li');
}

const readyReason = (s: Setup, postId: string) =>
  s.ctx.audit.eventsFor('post', postId).filter((e) => e.action === 'post.ready_to_publish').map((e) => String(e.details.reason));

describe('publishing', () => {
  it('without images a due post becomes READY_TO_PUBLISH with the reason', async () => {
    const s = setupContent({ publish: true });
    const post = await scheduledPost(s);
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.deepEqual(res.ready_to_publish.map((p) => p.id), [post.id]);
    assert.equal(res.ready_to_publish[0].status, 'READY_TO_PUBLISH');
    assert.deepEqual(readyReason(s, post.id), [NO_IMAGE_REASON]);
  });

  it('a video note is published through the video publisher with no images', async () => {
    const s = setupContent({ publish: true });
    const post = await scheduledPost(s);
    setPostVideo(s.ctx, post.id, '/srv/videos/提车日.mp4', 'operator:li');
    const drafts: { images?: string[]; video?: string | null }[] = [];
    s.ctx.xhs = withOverrides(s.ctx.xhs, {
      publishNote: async (_accountId, draft) => {
        drafts.push({ images: draft.images, video: draft.video });
        return { ok: true, data: { platform_note_id: 'sim-video-1', url: null } };
      },
    });
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.deepEqual(res.published.map((p) => p.id), [post.id]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].video, '/srv/videos/提车日.mp4');
    assert.deepEqual(drafts[0].images, [], 'a video note carries no images');
    assert.equal(
      s.ctx.audit.eventsFor('post', post.id).find((e) => e.action === 'post.published')?.details.video,
      '/srv/videos/提车日.mp4',
    );
  });

  it('a video must be one absolute local path with a video extension', () => {
    const s = setupContent({ publish: true });
    const post = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-sales-wang'), pillar: 'model_review', model: 'X3', slot_date: '2026-09-11' });
    assert.throws(() => setPostVideo(s.ctx, post.id, 'https://example.com/a.mp4', 'operator:li'), ValidationError);
    assert.throws(() => setPostVideo(s.ctx, post.id, 'videos/a.mp4', 'operator:li'), ValidationError);
    assert.throws(() => setPostVideo(s.ctx, post.id, '/srv/videos/a.txt', 'operator:li'), ValidationError);
    assert.equal(setPostVideo(s.ctx, post.id, '/srv/videos/a.mp4', 'operator:li').video, '/srv/videos/a.mp4');
    assert.equal(setPostVideo(s.ctx, post.id, '', 'operator:li').video, null, 'an empty value clears it');
  });

  it('publish capability unavailable → READY_TO_PUBLISH citing the capability status', async () => {
    const s = setupContent(); // simulation publishing disabled by default
    const post = await scheduledPost(s);
    setPostImages(s.ctx, post.id, ['https://example.com/a.jpg'], 'operator:li');
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(res.ready_to_publish[0]?.id, post.id);
    assert.match(readyReason(s, post.id)[0], /发布能力不可用（UNAVAILABLE）/);
    assert.equal(res.published.length, 0);
  });

  it('confirmed simulation publish with images → PUBLISHED with the provider note id; daily limit respected', async () => {
    const s = setupContent({ publish: true });
    const a = await scheduledPost(s, 'xhs-hz-sales-wang', 'model_review', 'X3');
    const b = await scheduledPost(s, 'xhs-hz-sales-wang', 'price_offer', 'i3');
    const c = await scheduledPost(s, 'xhs-hz-sales-wang', 'model_review', '3 Series');
    for (const p of [a, b, c]) setPostImages(s.ctx, p.id, ['/srv/images/x3.jpg'], 'operator:li');
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(res.published.length, 2, 'default daily_publish_limit is 2');
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /今日发布上限/);
    for (const p of res.published) {
      assert.equal(p.status, 'PUBLISHED');
      assert.match(p.platform_note_id ?? '', /^sim-note-\d+$/);
      assert.equal(p.published_at, s.ctx.clock.iso());
    }
    assert.equal(s.sim.publishedNotes().length, 2);
  });

  it('a confirmed publish without a note id stays unreconciled until a human records the link', async () => {
    const s = setupContent({ publish: true });
    s.ctx.xhs = withOverrides(s.sim, { publishNote: async () => ({ ok: true, data: { platform_note_id: null, url: null } }) });
    const post = await scheduledPost(s);
    setPostImages(s.ctx, post.id, ['https://example.com/a.jpg'], 'operator:li');
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(res.published[0].platform_note_id, null);
    assert.ok(s.ctx.audit.eventsFor('post', post.id).some((e) => e.action === 'post.published_unreconciled'));
    const reconciled = markPublishedManually(s.ctx, post.id, { url: 'https://www.xiaohongshu.com/explore/66f0a1b2c3d4e5f600000001?xsec_token=abc' }, 'operator:li');
    assert.equal(reconciled.platform_note_id, '66f0a1b2c3d4e5f600000001');
    assert.equal(reconciled.published_at, res.published[0].published_at);
  });

  it('unknown outcome → READY_TO_PUBLISH, never retried automatically; requeue is a human decision', async () => {
    const s = setupContent({ publish: true });
    let calls = 0;
    s.ctx.xhs = withOverrides(s.sim, {
      publishNote: async () => {
        calls++;
        return { ok: false, status: 'REQUIRES_REVIEW', reason: 'publish_content outcome unknown: timeout', retryable: false };
      },
    });
    const post = await scheduledPost(s);
    setPostImages(s.ctx, post.id, ['https://example.com/a.jpg'], 'operator:li');
    const first = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(first.ready_to_publish[0].status, 'READY_TO_PUBLISH');
    assert.ok(readyReason(s, post.id)[0].startsWith(UNKNOWN_OUTCOME_REASON));
    await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(calls, 1, 'not retried');
    const requeued = requeuePost(s.ctx, post.id, 'operator:li');
    assert.equal(requeued.status, 'SCHEDULED');
    assert.throws(() => requeuePost(s.ctx, post.id, 'operator:li'), PolicyError);
  });

  it('retryable provider failure keeps the post scheduled; hard failure → FAILED', async () => {
    const s = setupContent({ publish: true });
    let mode: 'retry' | 'hard' = 'retry';
    s.ctx.xhs = withOverrides(s.sim, {
      publishNote: async () =>
        mode === 'retry'
          ? { ok: false, status: 'UNAVAILABLE', reason: 'network timeout before dispatch', retryable: true }
          : { ok: false, status: 'UNAVAILABLE', reason: '发布失败: 标题违规', retryable: false },
    });
    const post = await scheduledPost(s);
    setPostImages(s.ctx, post.id, ['https://example.com/a.jpg'], 'operator:li');
    const r1 = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(r1.skipped[0]?.post_id, post.id);
    assert.equal(s.ctx.db.table('posts').require(post.id).status, 'SCHEDULED');
    mode = 'hard';
    const r2 = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(r2.failed[0]?.status, 'FAILED');
  });

  it('future slots are not published and expired facts block publishing', async () => {
    const s = setupContent({ publish: true });
    const p = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-official'), pillar: 'price_offer', model: 'i3', slot_date: '2026-09-29' });
    await generatePost(s.ctx, p.id);
    reviewPost(s.ctx, p.id);
    const approved = approvePost(s.ctx, p.id, 'operator:li');
    setPostImages(s.ctx, p.id, ['https://example.com/a.jpg'], 'operator:li');
    assert.ok(Date.parse(approved.scheduled_for ?? '') > s.ctx.clock.now().getTime());
    assert.equal((await publishDuePosts(s.ctx, s.dealerId)).published.length, 0);
    s.ctx.clock.set('2026-10-01T05:00:00.000Z');
    const res = await publishDuePosts(s.ctx, s.dealerId);
    assert.equal(res.changes_required[0]?.id, p.id, 'September offer expired before publishing');
  });

  it('manual publish: URL parsing, validation, duplicate note ids', async () => {
    const s = setupContent();
    assert.equal(parseNoteIdFromUrl('https://www.xiaohongshu.com/explore/66f0a1b2c3d4e5f600000002'), '66f0a1b2c3d4e5f600000002');
    assert.equal(parseNoteIdFromUrl('https://www.xiaohongshu.com/discovery/item/66f0a1b2c3d4e5f600000003?source=x'), '66f0a1b2c3d4e5f600000003');
    assert.equal(parseNoteIdFromUrl('http://xhslink.com/a/AbCdEf'), null);
    assert.equal(parseNoteIdFromUrl('https://evil.example.com/explore/66f0a1b2c3d4e5f600000003'), null);

    const a = await scheduledPost(s);
    const b = await scheduledPost(s, 'xhs-hz-official', 'model_review', 'i3');
    assert.throws(() => markPublishedManually(s.ctx, a.id, { url: 'http://xhslink.com/a/AbCdEf' }, 'operator:li'), ValidationError);
    assert.throws(
      () => markPublishedManually(s.ctx, a.id, { url: 'https://www.xiaohongshu.com/explore/66f0a1b2c3d4e5f600000002', platform_note_id: '66f0a1b2c3d4e5f600000009' }, 'operator:li'),
      ValidationError,
    );
    const published = markPublishedManually(s.ctx, a.id, { url: 'https://www.xiaohongshu.com/explore/66f0a1b2c3d4e5f600000002' }, 'operator:li');
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(s.ctx.audit.eventsFor('post', a.id).some((e) => e.action === 'post.published_manually' && e.actor === 'operator:li'));
    assert.throws(() => markPublishedManually(s.ctx, b.id, { platform_note_id: '66f0a1b2c3d4e5f600000002' }, 'operator:li'), PolicyError);
    const inReview = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-i3'), pillar: 'model_review', model: 'i3', status: 'IN_REVIEW' });
    assert.throws(() => markPublishedManually(s.ctx, inReview.id, { platform_note_id: '66f0a1b2c3d4e5f600000004' }, 'operator:li'), PolicyError);
    assert.throws(() => setPostImages(s.ctx, b.id, ['relative/path.jpg'], 'operator:li'), ValidationError);
  });

  it('collects engagement through the owning account and records manual metrics', async () => {
    const s = setupContent({ publish: true });
    const post = await scheduledPost(s);
    setPostImages(s.ctx, post.id, ['https://example.com/a.jpg'], 'operator:li');
    await publishDuePosts(s.ctx, s.dealerId);
    s.ctx.clock.advance({ hours: 16 });
    const res = await collectPerformance(s.ctx, s.dealerId);
    assert.equal(res.status, 'AVAILABLE');
    assert.equal(res.updated, 1);
    const row = s.ctx.db.table('posts').require(post.id);
    assert.ok(row.metrics.views > 0 && row.metrics.likes >= 0);
    assert.equal(row.metrics_updated_at, s.ctx.clock.iso());

    const manual = recordPostMetrics(s.ctx, post.id, { views: 5000, collects: 321 }, 'operator:li');
    assert.equal(manual.metrics.views, 5000);
    assert.equal(manual.metrics.collects, 321);
    assert.throws(() => recordPostMetrics(s.ctx, post.id, { views: -1 }, 'operator:li'), ValidationError);
  });

  it('reports an honest status when the account session needs login', async () => {
    const setup = setupContent({ publish: true });
    const post = await scheduledPost(setup);
    markPublishedManually(setup.ctx, post.id, { platform_note_id: 'note-own-hz-x3-001' }, 'operator:li');
    const internal = setup.acc('xhs-hz-sales-wang');
    setup.ctx.xhs = withOverrides(setup.sim, {
      capabilities: async (a) => {
        const r = await setup.sim.capabilities(a);
        if (a === internal) r.capabilities.read_engagement = { capability: 'read_engagement', status: 'REQUIRES_AUTH', reason: 'session expired' };
        return r;
      },
    });
    const res = await collectPerformance(setup.ctx, setup.dealerId);
    assert.equal(res.updated, 0);
    assert.equal(res.status, 'REQUIRES_AUTH');
    assert.match(res.reason, /session expired/);
  });
});
