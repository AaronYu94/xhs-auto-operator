import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import {
  approveEngagementReply,
  cancelEngagementReply,
  draftEngagementReplies,
  markEngagementReplySentManually,
  sendEngagementReply,
} from '../../../src/skills/content/engagement/index.ts';
import { verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import { insertComment, insertPost, insertPublicPost, setPublishPolicy, setupContent, withOverrides } from './helpers.ts';

type Setup = ReturnType<typeof setupContent>;

function ownNote(s: Setup) {
  const post = insertPost(s.ctx, {
    dealer_id: s.dealerId,
    account_id: s.acc('xhs-hz-i3'),
    pillar: 'inventory_showcase',
    model: 'i3',
    status: 'PUBLISHED',
    title: '杭州i3 35L白外红内实拍｜店里现车',
    body: '今天到店的i3 eDrive35L 白外红内',
    platform_note_id: 'note-own-hz-i3-001',
    published_at: '2026-09-09T02:00:00.000Z',
  });
  const pp = insertPublicPost(s.ctx, {
    platform_post_id: 'note-own-hz-i3-001',
    xsec_token: 'ABsimOwnHzI3001mZ7=',
    title: '杭州i3 35L白外红内实拍｜店里现车',
    content: '今天到店的i3 eDrive35L 白外红内，实车颜值真的顶',
    author_platform_user_id: 'xhs-hz-i3',
    author_nickname: 'i3电车研究所',
    own_post_id: post.id,
  });
  const c = (id: string, author: string, nickname: string, content: string) =>
    insertComment(s.ctx, { public_post_id: pp.id, platform_comment_id: id, author, nickname, content });
  return {
    post,
    pp,
    buyer: c('c-own-i3-001', 'u-hz-buyer-002', '钱塘江的风', '这台白色35L还在吗？多少钱'),
    praise: c('c-test-praise', 'u-fan-001', '路过的小李', '太帅了'),
    spam: c('c-test-spam', 'u-dealer-spam-001', '车商老张', '有需要的朋友私信我底价，4S店销售'),
    managed: c('c-test-managed', 'xhs-hz-official', '杭州宝马中心官方', '欢迎到店看车，现在优惠多少可以问我们'),
    dnc: c('c-test-dnc', 'u-dnc-001', '不想被打扰', 'i3现在优惠多少'),
  };
}

function suppress(s: Setup, user: string) {
  s.ctx.db.table('contact_suppressions').insert({ id: newId('sup'), platform: 'xiaohongshu', platform_user_id: user, reason: '不需要，别再发了', source: 'test', created_at: s.ctx.clock.iso() });
}

describe('engagement', () => {
  it('answers the buyer with verified facts, thanks praise, skips marketing / managed / do-not-contact; idempotent', async () => {
    const s = setupContent();
    const n = ownNote(s);
    suppress(s, 'u-dnc-001');
    const drafts = await draftEngagementReplies(s.ctx, s.dealerId);
    const byComment = new Map(drafts.map((d) => [d.public_comment_id, d]));
    assert.deepEqual([...byComment.keys()].sort(), [n.buyer.id, n.praise.id].sort());

    const answer = byComment.get(n.buyer.id)!;
    assert.equal(answer.status, 'READY_FOR_REVIEW', 'REVIEW_REQUIRED policy + reply capability disabled in simulation');
    assert.equal(answer.account_id, s.acc('xhs-hz-i3'), 'the note owner replies');
    assert.ok(answer.message.includes('白外红内现车1台'), answer.message);
    assert.ok(answer.message.includes('指导价35.39万'), answer.message);
    assert.ok(answer.message.includes('留资卡'));
    assert.ok(verifyClaims(s.ctx, s.dealerId, answer.message, answer.fact_refs).passed);
    assert.ok(answer.guard_results.find((g) => g.check === 'factual_verification')?.passed);
    assert.equal(answer.guard_results.find((g) => g.check === 'provider_capability')?.passed, false);
    assert.equal(s.ctx.audit.decisionsFor('comment', n.buyer.id)[0]?.decision_type, 'engagement_reply');

    const thanks = byComment.get(n.praise.id)!;
    assert.equal(thanks.fact_refs.length, 0);
    assert.doesNotMatch(thanks.message, /\d/);

    assert.equal((await draftEngagementReplies(s.ctx, s.dealerId)).length, 0, 'second run drafts nothing');
  });

  it('AUTO policy + reply capability + all guards → SENT with the provider id', async () => {
    const s = setupContent({ reply_comments: true });
    setPublishPolicy(s.ctx, s.dealerId, 'AUTO');
    const n = ownNote(s);
    const drafts = await draftEngagementReplies(s.ctx, s.dealerId);
    const answer = drafts.find((d) => d.public_comment_id === n.buyer.id)!;
    assert.equal(answer.status, 'SENT');
    assert.match(answer.provider_message_id ?? '', /^sim-reply-\d+$/);
    assert.equal(s.sim.sentReplies()[0].platform_comment_id, 'c-own-i3-001');
    const praise = drafts.find((d) => d.public_comment_id === n.praise.id)!;
    assert.equal(praise.status, 'READY_FOR_REVIEW', 'simulation refuses a comment that is not in its corpus → human review');
  });

  it('human approval re-runs guards: invented price → BLOCKED; valid edit → APPROVED → manual send', async () => {
    const s = setupContent();
    const n = ownNote(s);
    const drafts = await draftEngagementReplies(s.ctx, s.dealerId);
    const answer = drafts.find((d) => d.public_comment_id === n.buyer.id)!;
    const blocked = await approveEngagementReply(s.ctx, answer.id, 'operator:li', '你好～这台现在优惠15万，快来！');
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.guard_results.find((g) => g.check === 'factual_verification')?.passed, false);

    const fixed = await approveEngagementReply(s.ctx, answer.id, 'operator:li', answer.message);
    assert.equal(fixed.status, 'APPROVED', 'reply capability unavailable → waits for a human');
    await assert.rejects(() => sendEngagementReply(s.ctx, answer.id), PolicyError);
    const sent = markEngagementReplySentManually(s.ctx, answer.id, 'operator:li');
    assert.equal(sent.status, 'SENT_MANUALLY');
    assert.ok(s.ctx.audit.eventsFor('engagement_reply', answer.id).some((e) => e.action === 'engagement_reply.sent_manually' && e.details.sent_by === 'operator:li'));
    assert.throws(() => cancelEngagementReply(s.ctx, answer.id, 'operator:li', 'x'), PolicyError);
  });

  it('suppression after drafting blocks the manual send; cancellation works', async () => {
    const s = setupContent();
    const n = ownNote(s);
    const drafts = await draftEngagementReplies(s.ctx, s.dealerId);
    const answer = drafts.find((d) => d.public_comment_id === n.buyer.id)!;
    suppress(s, 'u-hz-buyer-002');
    assert.throws(() => markEngagementReplySentManually(s.ctx, answer.id, 'operator:li'), PolicyError);
    const cancelled = cancelEngagementReply(s.ctx, answer.id, 'operator:li', '用户要求勿扰');
    assert.equal(cancelled.status, 'CANCELLED');
  });

  it('an unknown reply outcome is never re-sent automatically', async () => {
    const s = setupContent({ reply_comments: true });
    let calls = 0;
    s.ctx.xhs = withOverrides(s.sim, {
      replyToComment: async () => {
        calls++;
        return { ok: false, status: 'REQUIRES_REVIEW', reason: 'reply_comment_in_feed outcome unknown', retryable: false };
      },
    });
    const n = ownNote(s);
    const drafts = await draftEngagementReplies(s.ctx, s.dealerId);
    const answer = drafts.find((d) => d.public_comment_id === n.buyer.id)!;
    assert.equal(answer.status, 'READY_FOR_REVIEW');
    const approved = await approveEngagementReply(s.ctx, answer.id, 'operator:li');
    assert.equal(calls, 1, 'approval after an unknown outcome does not send again');
    assert.equal(approved.status, 'APPROVED');
    await assert.rejects(() => sendEngagementReply(s.ctx, answer.id), (err: unknown) => err instanceof PolicyError && err.code === 'reply_outcome_unknown');
  });
});
