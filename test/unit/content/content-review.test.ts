import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { generatePost } from '../../../src/skills/content/post-generation/index.ts';
import { HUMAN_CONFIRMATION_NOTE, approvePost, rejectPost, reviewPost } from '../../../src/skills/content/content-review/index.ts';
import { insertPost, setPublishPolicy, setupContent } from './helpers.ts';

async function drafted(s: ReturnType<typeof setupContent>, account: string, pillar: 'price_offer' | 'model_review' | 'customer_story' = 'price_offer', model: string | null = 'i3', slot = '2026-09-13') {
  const p = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc(account), pillar, model, slot_date: slot });
  return generatePost(s.ctx, p.id);
}

describe('content-review', () => {
  it('a clean draft passes all checks and waits in IN_REVIEW under REVIEW_REQUIRED, with decisions', async () => {
    const s = setupContent();
    const post = await drafted(s, 'xhs-hz-sales-wang');
    const reviewed = reviewPost(s.ctx, post.id);
    assert.equal(reviewed.status, 'IN_REVIEW');
    assert.ok(reviewed.review?.fact_check.passed, reviewed.review?.fact_check.issues.join('|') ?? 'no review');
    assert.ok(reviewed.review?.duplicate_check.passed);
    assert.ok(reviewed.review?.compliance.passed, reviewed.review?.compliance.issues.join('|') ?? 'no review');
    assert.ok((reviewed.review?.fact_check.verified_claims.length ?? 0) > 0);
    const types = s.ctx.audit.decisionsFor('post', post.id).map((d) => d.decision_type);
    assert.ok(types.includes('content_fact_review') && types.includes('content_duplicate_review'));
  });

  it('an injected unverifiable price sends the post back with CHANGES_REQUIRED', async () => {
    const s = setupContent();
    const post = await drafted(s, 'xhs-hz-official');
    s.ctx.db.table('posts').update(post.id, { body: post.body.replace('优惠9万', '优惠12万') });
    const reviewed = reviewPost(s.ctx, post.id);
    assert.equal(reviewed.status, 'CHANGES_REQUIRED');
    assert.equal(reviewed.review?.fact_check.passed, false);
    assert.ok(reviewed.review?.fact_check.issues.some((i) => i.includes('12万')));
  });

  it('catches a near-duplicate of another account’s post', async () => {
    const s = setupContent();
    const original = await drafted(s, 'xhs-hz-sales-wang');
    const copy = await drafted(s, 'xhs-hz-guide', 'model_review');
    s.ctx.db.table('posts').update(copy.id, { title: original.title, body: original.body, fact_refs: original.fact_refs, tags: original.tags });
    const reviewed = reviewPost(s.ctx, copy.id);
    assert.equal(reviewed.status, 'CHANGES_REQUIRED');
    assert.equal(reviewed.review?.duplicate_check.passed, false);
    assert.equal(reviewed.review?.duplicate_check.similar_post_id, original.id);
  });

  it('contact information fails compliance', async () => {
    const s = setupContent();
    const post = await drafted(s, 'xhs-hz-sales-wang');
    s.ctx.db.table('posts').update(post.id, { body: `${post.body}\n想要底价加微信abc12345` });
    const reviewed = reviewPost(s.ctx, post.id);
    assert.equal(reviewed.status, 'CHANGES_REQUIRED');
    assert.equal(reviewed.review?.compliance.passed, false);
  });

  it('AUTO policy schedules at the account-type slot in dealer time; customer stories still need a human', async () => {
    const s = setupContent();
    setPublishPolicy(s.ctx, s.dealerId, 'AUTO');
    const sales = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-sales-wang', 'price_offer', 'i3', '2026-09-14')).id);
    assert.equal(sales.status, 'SCHEDULED');
    assert.equal(sales.approval_policy, 'AUTO');
    assert.equal(sales.scheduled_for, '2026-09-14T11:30:00.000Z', 'salesperson 19:30 Asia/Shanghai');
    const official = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-official', 'model_review', 'X3', '2026-09-14')).id);
    assert.equal(official.scheduled_for, '2026-09-14T04:00:00.000Z', 'official 12:00 Asia/Shanghai');
    const past = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-i3', 'model_review', 'i4', '2026-09-01')).id);
    assert.equal(past.scheduled_for, s.ctx.clock.iso(), 'a past slot publishes at the next run, not in the past');
    const story = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-story', 'customer_story', 'X3', '2026-09-14')).id);
    assert.equal(story.status, 'IN_REVIEW');
    assert.ok(story.review?.compliance.issues.includes(HUMAN_CONFIRMATION_NOTE));
  });

  it('approve / reject rules and re-verification at approval time', async () => {
    const s = setupContent();
    const post = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-sales-wang')).id);
    assert.throws(() => approvePost(s.ctx, (insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-i3'), pillar: 'model_review', model: 'i3' })).id, 'operator:li'), PolicyError);
    const approved = approvePost(s.ctx, post.id, 'operator:li');
    assert.equal(approved.status, 'SCHEDULED');
    assert.ok(approved.scheduled_for);
    assert.ok(s.ctx.audit.eventsFor('post', post.id).some((e) => e.action === 'post.approved' && e.actor === 'operator:li'));

    const other = reviewPost(s.ctx, (await drafted(s, 'xhs-hz-official', 'price_offer', 'i3', '2026-09-20')).id);
    s.ctx.clock.set('2026-10-02T02:00:00.000Z'); // September offers expired
    const refused = approvePost(s.ctx, other.id, 'operator:li');
    assert.equal(refused.status, 'CHANGES_REQUIRED');
    assert.equal(refused.review?.fact_check.passed, false);

    const rejected = rejectPost(s.ctx, refused.id, 'operator:li', '角度不合适');
    assert.equal(rejected.status, 'REJECTED');
    assert.throws(() => rejectPost(s.ctx, refused.id, 'operator:li', 'again'), PolicyError);
  });
});
