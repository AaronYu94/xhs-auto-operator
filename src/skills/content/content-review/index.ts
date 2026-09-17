/**
 * content-review (spec §15, ARCHITECTURE §8 C4): fact review + duplicate review + compliance for drafted posts, then the
 * publish approval policy: AUTO → SCHEDULED (approved, with a slot time) · REVIEW_REQUIRED / DISABLED → IN_REVIEW.
 */
import type { AppContext } from '../../../app/context.ts';
import { PolicyError, ValidationError } from '../../../core/errors.ts';
import { textSimilarity } from '../../../core/text.ts';
import { localDateKey, zonedTimeToUtc } from '../../../core/time.ts';
import type { AccountType, FactRef, Post, PostReview, PostStatus } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { effectivePublishPolicy, ensurePersona, requireAccount } from '../../operations/account-brain/index.ts';
import { checkPlatformRules, isNearDuplicate } from '../../operations/compliance/index.ts';
import { getDealer, getProhibitedClaims, verifyClaims } from '../../operations/dealer-brain/index.ts';
import { dealerTz } from '../../operations/dealer-brain/shared.ts';
import { defineSkill } from '../../registry.ts';
import { POST_MAX_LENGTH, formatIssues, tabooHits, titleModelLabel } from '../post-generation/composer.ts';

export const REVIEW_AGENT = 'content-review-agent';
export const DUPLICATE_THRESHOLD = 0.85;
export const DUPLICATE_WINDOW_DAYS = 60;
/** Dealer-local publish slot per account type. */
export const PUBLISH_SLOT: Readonly<Record<AccountType, { hour: number; minute: number }>> = {
  official: { hour: 12, minute: 0 },
  salesperson: { hour: 19, minute: 30 },
  model_specialist: { hour: 20, minute: 30 },
  local_guide: { hour: 18, minute: 0 },
  customer_story: { hour: 21, minute: 0 },
};
export const HUMAN_CONFIRMATION_NOTE = '需人工确认：车主故事类内容必须取得车主本人授权，不得发布未经确认的车主经历';
export const DISABLED_POLICY_NOTE = '发布审批策略为DISABLED：系统不会自动发布，需人工处理';

const REVIEWABLE: readonly PostStatus[] = ['DRAFTED', 'IN_REVIEW'];
const REJECTABLE: readonly PostStatus[] = ['PLANNED', 'DRAFTED', 'CHANGES_REQUIRED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'READY_TO_PUBLISH', 'FAILED'];

const postText = (p: Pick<Post, 'title' | 'cover_text' | 'body'>) => `${p.title}\n${p.cover_text}\n${p.body}`;

/** scheduled_for for an approved post: slot_date at the account type's local hour; never in the past. */
export function computeScheduledFor(ctx: AppContext, post: Post): string {
  const account = requireAccount(ctx, post.account_id);
  const dealer = getDealer(ctx, post.dealer_id);
  const tz = dealerTz(dealer);
  const slot = PUBLISH_SLOT[account.account_type];
  const [y, m, d] = post.slot_date.split('-').map(Number);
  const at = zonedTimeToUtc(y, m, d, slot.hour, slot.minute, tz);
  const now = ctx.clock.now();
  return (at.getTime() < now.getTime() ? now : at).toISOString();
}

export interface DuplicateFinding {
  passed: boolean;
  max_similarity: number;
  similar_post_id?: string;
}

/** Near-duplicate check against the dealer's other drafted/published posts (all accounts) of the last 60 days. */
export function checkDuplicate(ctx: AppContext, post: Post): DuplicateFinding {
  const since = new Date(ctx.clock.now().getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();
  const others = ctx.db
    .table('posts')
    .query(
      `dealer_id = ? AND id <> ? AND status NOT IN ('PLANNED', 'REJECTED') AND body <> '' AND (created_at >= ? OR (published_at IS NOT NULL AND published_at >= ?))`,
      [post.dealer_id, post.id, since, since],
    );
  const text = `${post.title}\n${post.body}`;
  const verdict = isNearDuplicate(text, others.map((o) => `${o.title}\n${o.body}`), DUPLICATE_THRESHOLD);
  let similar: string | undefined;
  let best = -1;
  for (const o of others) {
    const sim = textSimilarity(text, `${o.title}\n${o.body}`);
    if (sim > best) {
      best = sim;
      similar = o.id;
    }
  }
  return { passed: !verdict.duplicate, max_similarity: verdict.max_similarity, ...(verdict.duplicate && similar ? { similar_post_id: similar } : {}) };
}

export interface ReviewResult {
  review: PostReview;
  /** blocking failures exist → CHANGES_REQUIRED */
  blocking: boolean;
  /** passed, but a human must look at it regardless of policy */
  needs_human: boolean;
}

/** Pure-read evaluation of a post (no writes). */
export function evaluatePost(ctx: AppContext, post: Post): ReviewResult {
  const text = postText(post);
  const facts = verifyClaims(ctx, post.dealer_id, text, post.fact_refs);
  const duplicate = checkDuplicate(ctx, post);
  const compliance: string[] = [];
  const notes: string[] = [];
  if (!post.body.trim()) compliance.push('正文为空');
  const rules = checkPlatformRules(text, { prohibited: getProhibitedClaims(ctx, post.dealer_id), max_length: POST_MAX_LENGTH, channel: 'post' });
  compliance.push(...rules.issues.map((i) => (i.quote ? `${i.message}（“${i.quote}”）` : i.message)));
  const account = requireAccount(ctx, post.account_id);
  const persona = ensurePersona(ctx, account);
  const taboo = tabooHits(persona, text);
  if (taboo.length > 0) compliance.push(`触及账号人设禁忌话题：${taboo.join('、')}`);
  compliance.push(...formatIssues(post, titleModelLabel(ctx, post)));

  const needsHuman = account.account_type === 'customer_story' || post.pillar === 'customer_story';
  if (needsHuman) notes.push(HUMAN_CONFIRMATION_NOTE);

  const review: PostReview = {
    fact_check: { passed: facts.passed, issues: facts.issues, verified_claims: facts.verified },
    duplicate_check: duplicate,
    compliance: { passed: compliance.length === 0, issues: [...compliance, ...notes] },
    reviewed_at: ctx.clock.iso(),
  };
  return { review, blocking: !facts.passed || !duplicate.passed || compliance.length > 0, needs_human: needsHuman };
}

/** DRAFTED | IN_REVIEW → CHANGES_REQUIRED | IN_REVIEW | SCHEDULED (AUTO policy). */
export function reviewPost(ctx: AppContext, postId: string): Post {
  const post = ctx.db.table('posts').require(postId);
  if (!REVIEWABLE.includes(post.status)) {
    throw new PolicyError('invalid_post_status', `只能审核 DRAFTED / IN_REVIEW 状态的内容，当前为 ${post.status}`, { post_id: postId, status: post.status });
  }
  const { review, blocking, needs_human } = evaluatePost(ctx, post);
  const policy = effectivePublishPolicy(ctx, post.account_id).policy;
  let status: PostStatus;
  if (blocking) status = 'CHANGES_REQUIRED';
  else if (policy === 'AUTO' && !needs_human) status = 'SCHEDULED';
  else status = 'IN_REVIEW';
  if (!blocking && policy === 'DISABLED') review.compliance.issues.push(DISABLED_POLICY_NOTE);
  const scheduledFor = status === 'SCHEDULED' ? computeScheduledFor(ctx, post) : null;

  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, {
      review,
      status,
      approval_policy: policy,
      ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    });
    ctx.audit.decision({
      agent: REVIEW_AGENT,
      skill: 'content-review',
      decision_type: 'content_fact_review',
      subject_type: 'post',
      subject_id: postId,
      inputs: { fact_refs: post.fact_refs, title: post.title, body_chars: [...post.body].length },
      evidence: review.fact_check.verified_claims.map((r: FactRef) => ({ code: 'verified_fact', label: r.claim, source_ref: `${r.kind}:${r.id}` })),
      output: { passed: review.fact_check.passed, issues: review.fact_check.issues, compliance: review.compliance, status, policy },
      confidence: 1,
      engine: 'rules',
    });
    ctx.audit.decision({
      agent: REVIEW_AGENT,
      skill: 'content-review',
      decision_type: 'content_duplicate_review',
      subject_type: 'post',
      subject_id: postId,
      inputs: { threshold: DUPLICATE_THRESHOLD, window_days: DUPLICATE_WINDOW_DAYS },
      evidence: review.duplicate_check.similar_post_id
        ? [{ code: 'near_duplicate', label: `与内容 ${review.duplicate_check.similar_post_id} 高度相似`, source_ref: review.duplicate_check.similar_post_id }]
        : [],
      output: { ...review.duplicate_check },
      confidence: 1,
      engine: 'rules',
    });
    ctx.audit.event({
      actor: `agent:${REVIEW_AGENT}`,
      action: status === 'CHANGES_REQUIRED' ? 'post.changes_required' : status === 'SCHEDULED' ? 'post.auto_approved' : 'post.in_review',
      entity_type: 'post',
      entity_id: postId,
      details: { previous_status: post.status, status, policy, scheduled_for: scheduledFor, needs_human },
    });
    return updated;
  });
}

/**
 * Human approval of an IN_REVIEW post. Facts, duplicates and compliance are re-evaluated first (offers may have
 * expired since review): a blocking failure moves the post to CHANGES_REQUIRED instead of approving it.
 */
export function approvePost(ctx: AppContext, postId: string, actor: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const post = ctx.db.table('posts').require(postId);
  if (post.status !== 'IN_REVIEW') {
    throw new PolicyError('invalid_post_status', `只能批准 IN_REVIEW 状态的内容，当前为 ${post.status}`, { post_id: postId, status: post.status });
  }
  const { review, blocking } = evaluatePost(ctx, post);
  const scheduledFor = blocking ? null : post.scheduled_for ?? computeScheduledFor(ctx, post);
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, {
      review,
      status: blocking ? 'CHANGES_REQUIRED' : 'SCHEDULED',
      ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    });
    ctx.audit.event({
      actor,
      action: blocking ? 'post.approval_refused' : 'post.approved',
      entity_type: 'post',
      entity_id: postId,
      details: blocking
        ? { reason: '审批时复核未通过', fact_issues: review.fact_check.issues, compliance: review.compliance.issues, duplicate: review.duplicate_check }
        : { scheduled_for: scheduledFor },
    });
    return updated;
  });
}

export function rejectPost(ctx: AppContext, postId: string, actor: string, reason: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  if (!reason?.trim()) throw new ValidationError('reason', 'required');
  const post = ctx.db.table('posts').require(postId);
  if (!REJECTABLE.includes(post.status)) {
    throw new PolicyError('invalid_post_status', `状态为 ${post.status} 的内容不能驳回`, { post_id: postId, status: post.status });
  }
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, { status: 'REJECTED' });
    ctx.audit.event({ actor, action: 'post.rejected', entity_type: 'post', entity_id: postId, details: { previous_status: post.status, reason: reason.trim() } });
    return updated;
  });
}

/** Posts waiting for a human (IN_REVIEW) for the console review queue, with review results. */
export function listReviewQueue(ctx: AppContext, dealerId: string): Post[] {
  getDealer(ctx, dealerId);
  return ctx.db.table('posts').findMany({ dealer_id: dealerId, status: ['IN_REVIEW', 'CHANGES_REQUIRED'] }, { orderBy: 'slot_date ASC, created_at ASC' });
}

/** Local date key a post was reviewed (helper for dashboards). */
export function reviewedLocalDate(ctx: AppContext, post: Post): string | null {
  if (!post.review) return null;
  return localDateKey(new Date(post.review.reviewed_at), dealerTz(getDealer(ctx, post.dealer_id)));
}

const reviewInput = v.object({
  post_id: v.string({ min: 1 }),
  action: v.withDefault(v.literal(['review', 'approve', 'reject'] as const), 'review'),
  actor: v.optional(v.string({ min: 1 })),
  reason: v.optional(v.string({ min: 1 })),
});

export const skill = defineSkill({
  name: 'content-review',
  category: 'content',
  agent: 'content-review-agent',
  description:
    '内容审核：用Dealer Brain核验笔记中的价格/优惠/金融/库存/日期表述，检查跨账号近似重复与平台合规（引流、禁用语、广告法、人设禁忌、格式），再按发布审批策略进入审核队列或排期。',
  input: reviewInput,
  run(ctx, input): Post {
    if (input.action === 'approve') return approvePost(ctx, input.post_id, input.actor ?? 'operator:unknown');
    if (input.action === 'reject') return rejectPost(ctx, input.post_id, input.actor ?? 'operator:unknown', input.reason ?? '');
    return reviewPost(ctx, input.post_id);
  },
});
