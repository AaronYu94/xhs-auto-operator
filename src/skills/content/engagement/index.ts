/**
 * engagement (spec §15 Engagement, ARCHITECTURE §3): public replies to comments left on OUR OWN published notes.
 *
 * Buyer questions get a short public answer built only from Dealer Brain rows (verified claims) that invites the user
 * to DM / use the 留资卡; plain praise gets a short thanks; marketing, refusals, managed accounts and do-not-contact users
 * get nothing. Replies are sent through the provider only when policy AUTO + reply_comments AVAILABLE + every guard
 * passes + the provider confirms; otherwise they wait in READY_FOR_REVIEW for a human.
 */
import type { AppContext } from '../../../app/context.ts';
import { PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { normalizeText } from '../../../core/text.ts';
import type {
  AccountType,
  CapabilityStatus,
  EngagementReply,
  FactRef,
  GuardResult,
  IntentDetection,
  Post,
  PublicComment,
  PublicPost,
  Vehicle,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { detectIntentRules } from '../../acquisition/intent-detection/nlu.ts';
import { parseColorIntent } from '../../acquisition/lead-scoring/index.ts';
import { effectivePublishPolicy, requireAccount } from '../../operations/account-brain/index.ts';
import { isAccountOperable } from '../../operations/account-health/index.ts';
import { checkPlatformRules, isNearDuplicate } from '../../operations/compliance/index.ts';
import { isSuppressed } from '../../operations/crm/index.ts';
import {
  answerFact,
  exactCny,
  findVehicles,
  getActiveOffers,
  getDealer,
  getDealerProfile,
  getProhibitedClaims,
  verifyClaims,
} from '../../operations/dealer-brain/index.ts';
import { dealerTz, formatMonthDay, localDateOf } from '../../operations/dealer-brain/shared.ts';
import { defineSkill } from '../../registry.ts';

export const ENGAGEMENT_AGENT = 'publishing-agent';
export const REPLY_MAX_LENGTH = 280;
export const COMMENT_WINDOW_DAYS = 30;
export const REPLY_DUPLICATE_THRESHOLD = 0.9;
export const INVITE_TEXT = '更详细的方案欢迎私信我们，或通过主页留资卡预约到店。';
const actorOf = () => `agent:${ENGAGEMENT_AGENT}`;

const GREETING: Readonly<Record<AccountType, string>> = {
  official: '您好，感谢关注！',
  salesperson: '你好呀～',
  model_specialist: '感谢提问，',
  local_guide: '你好～',
  customer_story: '感谢留言～',
};

const THANKS: Readonly<Record<AccountType, readonly string[]>> = {
  official: ['感谢您的喜欢，欢迎到店品鉴实车～', '谢谢支持！有任何问题欢迎随时留言。', '感谢关注，我们会持续分享门店资讯。'],
  salesperson: ['谢谢喜欢～有空来店里看看实车呀', '感谢支持！想了解什么评论区直接问我', '哈哈谢谢，实车更好看，欢迎来看～'],
  model_specialist: ['感谢认可，后续会继续更新实测内容。', '谢谢支持，有想看的测评方向欢迎留言。', '感谢关注，数据类问题欢迎随时交流。'],
  local_guide: ['谢谢喜欢～收藏起来买车时用得上', '感谢支持！还想看哪些本地攻略可以留言', '谢谢～有本地买车问题欢迎来问'],
  customer_story: ['谢谢你的留言，温暖的故事值得被记录～', '感谢支持！也欢迎分享你的用车故事', '谢谢喜欢，我们会继续记录真实车主的故事。'],
};

export type EngagementKind = 'answer' | 'thanks';

interface OwnComment {
  comment: PublicComment;
  public_post: PublicPost;
  post: Post;
}

function hashIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return mod > 0 ? (h >>> 0) % mod : 0;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function managedIdentities(ctx: AppContext, groupId: string): Set<string> {
  const ids = new Set<string>();
  for (const a of ctx.db.table('xhs_accounts').findMany({ group_id: groupId })) {
    if (a.platform_account_id) ids.add(a.platform_account_id);
    if (a.platform_user_id) ids.add(a.platform_user_id);
  }
  return ids;
}

/** Comments collected on the public copies of our own published notes (linked by own_post_id or note id). */
export function listOwnNoteComments(ctx: AppContext, dealerId: string): OwnComment[] {
  const posts = ctx.db.table('posts').findMany({ dealer_id: dealerId, status: 'PUBLISHED' });
  if (posts.length === 0) return [];
  const byId = new Map(posts.map((p) => [p.id, p]));
  const byNote = new Map(posts.filter((p) => p.platform_note_id).map((p) => [p.platform_note_id as string, p]));
  const ids = [...byId.keys()];
  const notes = [...byNote.keys()];
  const where = [`own_post_id IN (${placeholders(ids.length)})`];
  if (notes.length > 0) where.push(`platform_post_id IN (${placeholders(notes.length)})`);
  const publicPosts = ctx.db.table('public_posts').query(where.join(' OR '), [...ids, ...notes]);
  const out: OwnComment[] = [];
  for (const pp of publicPosts) {
    const post = (pp.own_post_id ? byId.get(pp.own_post_id) : undefined) ?? byNote.get(pp.platform_post_id);
    if (!post) continue;
    for (const comment of ctx.db.table('public_comments').findMany({ public_post_id: pp.id }, { orderBy: 'published_at ASC, fetched_at ASC' })) {
      out.push({ comment, public_post: pp, post });
    }
  }
  return out;
}

function classify(ctx: AppContext, item: OwnComment): { kind: EngagementKind | null; reason: string; detection: IntentDetection } {
  const detection = detectIntentRules(
    item.comment.content,
    {
      source_type: 'comment',
      post_title: item.public_post.title,
      post_content: item.public_post.content,
      ip_location: item.comment.ip_location,
      author_nickname: item.comment.author_nickname,
    },
    getDealerProfile(ctx, item.post.dealer_id),
  );
  const codes = new Set(detection.evidence.map((e) => e.code));
  if (detection.is_marketing || detection.author_role === 'marketing' || codes.has('marketing_account')) return { kind: null, reason: 'marketing', detection };
  if (detection.negative) return { kind: null, reason: 'negative', detection };
  if (codes.has('pure_praise')) return { kind: 'thanks', reason: 'praise', detection };
  if (detection.is_purchase_signal) return { kind: 'answer', reason: 'buyer_question', detection };
  if (detection.author_role === 'owner' || codes.has('already_purchased')) return { kind: 'thanks', reason: 'owner_remark', detection };
  return { kind: null, reason: 'no_reply_needed', detection };
}

function entryVehicle(vehicles: Vehicle[]): Vehicle | null {
  const newest = new Map<string, number>();
  for (const veh of vehicles) newest.set(veh.trim, Math.max(newest.get(veh.trim) ?? 0, veh.model_year));
  return vehicles.filter((veh) => veh.model_year === newest.get(veh.trim)).sort((a, b) => a.msrp - b.msrp)[0] ?? null;
}

/** Public answer to a buyer question from Dealer Brain rows only. */
export function composeAnswer(ctx: AppContext, post: Post, detection: IntentDetection): { message: string; fact_refs: FactRef[] } {
  const dealer = getDealer(ctx, post.dealer_id);
  const account = requireAccount(ctx, post.account_id);
  const model = detection.intent.model ?? post.model ?? undefined;
  const trim = detection.intent.trim;
  const q = new Set(detection.transaction_questions);
  const parts: string[] = [];
  const refs: FactRef[] = [];

  if (model && (q.has('inventory') || q.has('color_trim_availability'))) {
    const colours = parseColorIntent(detection.intent.color_intent);
    const ans = answerFact(ctx, dealer.id, { kind: 'inventory', model, trim, exterior_color: colours.exterior, interior_color: colours.interior });
    if (ans.found) {
      const claims = [...new Set(ans.facts.map((f) => f.claim))].slice(0, 3);
      parts.push(`目前门店有${claims.join('、')}，车源实时变动以当日确认为准`);
      refs.push(...ans.facts.filter((f) => claims.includes(f.claim)));
    } else {
      parts.push('这个配置需要到店再帮你确认车源');
    }
  }
  if (model && (q.has('price') || q.has('landing_price') || q.has('discount'))) {
    const vehicles = findVehicles(ctx, dealer.group_id, { model, trim });
    const veh = entryVehicle(trim ? vehicles.filter((x) => normalizeText(x.trim) === normalizeText(trim)) : vehicles) ?? entryVehicle(vehicles);
    if (veh) {
      const claim = `${veh.trim}指导价${exactCny(veh.msrp)}`;
      parts.push(claim);
      refs.push({ kind: 'vehicle', id: veh.id, claim });
    }
    const cash = getActiveOffers(ctx, dealer.id, { model, types: ['cash_discount'] }).find((o) => (o.amount ?? 0) > 0);
    if (cash) {
      const amount = `优惠${exactCny(cash.amount ?? 0)}`;
      const expiry = `截止日期${formatMonthDay(localDateOf(cash.valid_until, dealerTz(dealer)))}`;
      parts.push(`当前门店${amount}，${expiry}`);
      refs.push({ kind: 'offer', id: cash.id, claim: amount }, { kind: 'offer', id: cash.id, claim: expiry });
    }
    if (q.has('landing_price')) parts.push('落地价要结合上牌和保险单独核算');
  }
  if (model && q.has('finance')) {
    const f = getActiveOffers(ctx, dealer.id, { model, types: ['finance'] })[0];
    if (f) {
      const claims: string[] = [];
      if (f.term_months !== null) claims.push(`${f.term_months}期`);
      if (f.apr === 0) claims.push('0息');
      if (f.down_payment_pct !== null && Math.abs(f.down_payment_pct * 10 - Math.round(f.down_payment_pct * 10)) < 1e-9 && f.down_payment_pct > 0) {
        claims.push(`首付${Math.round(f.down_payment_pct * 10)}成`);
      }
      if (claims.length > 0) {
        parts.push(`金融方案有${claims.join('、')}，需审批`);
        for (const claim of claims) refs.push({ kind: 'offer', id: f.id, claim });
      }
    }
  }
  if (q.has('trade_in')) {
    const t = getActiveOffers(ctx, dealer.id, { types: ['trade_in'] }).find((o) => (o.amount ?? 0) > 0);
    if (t) {
      const claim = `补贴${exactCny(t.amount ?? 0)}`;
      parts.push(`置换可享${claim}，旧车以门店评估为准`);
      refs.push({ kind: 'offer', id: t.id, claim });
    }
  }
  if (q.has('test_drive') || q.has('dealer_location')) {
    if (dealer.business_hours.trim()) {
      parts.push(`门店营业时间${dealer.business_hours.trim()}，可以预约试驾`);
      refs.push({ kind: 'dealer', id: dealer.id, claim: dealer.business_hours.trim() });
    }
  }
  if (parts.length === 0 && model) {
    const veh = entryVehicle(findVehicles(ctx, dealer.group_id, { model }));
    const highlight = veh?.highlights.map((h) => h.trim()).find(Boolean);
    if (veh && highlight) {
      parts.push(highlight);
      refs.push({ kind: 'vehicle', id: veh.id, claim: highlight });
    }
  }
  const body = parts.length > 0 ? `${parts.join('；')}。` : '';
  return { message: `${GREETING[account.account_type]}${body}${INVITE_TEXT}`, fact_refs: refs };
}

export interface GuardContext {
  reply_capability: { status: CapabilityStatus; reason: string };
  human_approved: boolean;
}

/** Guard pipeline for a public reply (ARCHITECTURE §6 semantics: blocking → BLOCKED, non-blocking → review). */
export function runReplyGuards(
  ctx: AppContext,
  input: { post: Post; comment: PublicComment; public_post: PublicPost; message: string; fact_refs: FactRef[]; exclude_reply_id?: string },
  g: GuardContext,
): GuardResult[] {
  const out: GuardResult[] = [];
  const author = input.comment.author_platform_user_id;
  const suppression = author ? isSuppressed(ctx, author) : null;
  out.push(
    suppression
      ? { check: 'negative_feedback', passed: false, blocking: true, detail: `用户已在勿扰名单：${suppression.reason}` }
      : { check: 'negative_feedback', passed: true, blocking: false, detail: '用户不在勿扰名单' },
  );
  const operable = isAccountOperable(ctx, input.post.account_id);
  out.push({ check: 'account_health', passed: operable.ok, blocking: operable.blocking, detail: operable.reason });

  const facts = verifyClaims(ctx, input.post.dealer_id, input.message, input.fact_refs);
  out.push({
    check: 'factual_verification',
    passed: facts.passed,
    blocking: !facts.passed,
    detail: facts.passed ? `已核实${facts.verified.length}项门店事实` : facts.issues.join('；'),
  });
  const rules = checkPlatformRules(input.message, { prohibited: getProhibitedClaims(ctx, input.post.dealer_id), max_length: REPLY_MAX_LENGTH, channel: 'comment' });
  out.push({
    check: 'platform_rules',
    passed: rules.passed,
    blocking: !rules.passed,
    detail: rules.passed ? '符合平台规则' : rules.issues.map((i) => i.message).join('；'),
  });

  const since = new Date(ctx.clock.now().getTime() - COMMENT_WINDOW_DAYS * 86_400_000).toISOString();
  const recent = ctx.db
    .table('engagement_replies')
    .query(`account_id = ? AND created_at >= ? AND status NOT IN ('CANCELLED', 'BLOCKED') AND id <> ?`, [input.post.account_id, since, input.exclude_reply_id ?? ''])
    .map((r) => r.message);
  const dup = isNearDuplicate(input.message, recent, REPLY_DUPLICATE_THRESHOLD);
  out.push({
    check: 'duplicate',
    passed: !dup.duplicate,
    blocking: false,
    detail: dup.duplicate ? `与近期回复高度相似（${Math.round(dup.max_similarity * 100)}%），请人工确认避免模板化` : '无近似重复回复',
  });

  const policy = effectivePublishPolicy(ctx, input.post.account_id).policy;
  if (g.human_approved) out.push({ check: 'approval_policy', passed: true, blocking: false, detail: '已人工审核' });
  else if (policy === 'DISABLED') out.push({ check: 'approval_policy', passed: false, blocking: true, detail: '审批策略为DISABLED，不允许回复' });
  else if (policy === 'REVIEW_REQUIRED') out.push({ check: 'approval_policy', passed: false, blocking: false, detail: '审批策略要求人工审核' });
  else out.push({ check: 'approval_policy', passed: true, blocking: false, detail: '审批策略AUTO' });

  const hasToken = Boolean(input.public_post.xsec_token);
  const capOk = g.reply_capability.status === 'AVAILABLE' && hasToken;
  out.push({
    check: 'provider_capability',
    passed: capOk,
    blocking: false,
    detail: capOk
      ? '可通过平台接口公开回复'
      : !hasToken
        ? '缺少笔记xsec_token，无法自动回复，请人工在小红书回复'
        : `公开回复能力不可用（${g.reply_capability.status}）：${g.reply_capability.reason}`,
  });
  return out;
}

const hadUnknownOutcome = (ctx: AppContext, replyId: string) =>
  ctx.audit.eventsFor('engagement_reply', replyId).some((e) => e.action === 'engagement_reply.outcome_unknown');

async function replyCapability(ctx: AppContext, accountId: string): Promise<{ status: CapabilityStatus; reason: string }> {
  const cap = (await ctx.xhs.capabilities(accountId)).capabilities.reply_comments;
  return { status: cap.status, reason: cap.reason };
}

async function deliver(ctx: AppContext, reply: EngagementReply, item: OwnComment, fallback: 'READY_FOR_REVIEW' | 'APPROVED'): Promise<EngagementReply> {
  const res = await ctx.xhs.replyToComment(
    reply.account_id,
    {
      platform_post_id: item.public_post.platform_post_id,
      xsec_token: item.public_post.xsec_token,
      platform_comment_id: item.comment.platform_comment_id,
      platform_user_id: item.comment.author_platform_user_id,
    },
    reply.message,
  );
  return ctx.db.tx(() => {
    if (res.ok) {
      const row = ctx.db.table('engagement_replies').update(reply.id, { status: 'SENT', provider_message_id: res.data.provider_message_id, capability_status: 'AVAILABLE' });
      ctx.audit.event({ actor: actorOf(), action: 'engagement_reply.sent', entity_type: 'engagement_reply', entity_id: reply.id, details: { provider: ctx.xhs.name, provider_message_id: res.data.provider_message_id } });
      return row;
    }
    const row = ctx.db.table('engagement_replies').update(reply.id, { status: fallback, capability_status: res.status });
    ctx.audit.event({
      actor: actorOf(),
      action: res.status === 'REQUIRES_REVIEW' ? 'engagement_reply.outcome_unknown' : 'engagement_reply.send_failed',
      entity_type: 'engagement_reply',
      entity_id: reply.id,
      details: { status: res.status, reason: res.reason, retryable: res.retryable ?? false },
    });
    return row;
  });
}

function itemFor(ctx: AppContext, reply: EngagementReply): OwnComment {
  const comment = ctx.db.table('public_comments').require(reply.public_comment_id);
  return { comment, public_post: ctx.db.table('public_posts').require(comment.public_post_id), post: ctx.db.table('posts').require(reply.post_id) };
}

/** Draft (and, under AUTO with full capability, send) public replies to new comments on our own notes. */
export async function draftEngagementReplies(ctx: AppContext, dealerId: string): Promise<EngagementReply[]> {
  const dealer = getDealer(ctx, dealerId);
  const managed = managedIdentities(ctx, dealer.group_id);
  const sinceMs = ctx.clock.now().getTime() - COMMENT_WINDOW_DAYS * 86_400_000;
  const caps = new Map<string, { status: CapabilityStatus; reason: string }>();
  const created: EngagementReply[] = [];

  for (const item of listOwnNoteComments(ctx, dealerId)) {
    const { comment, post } = item;
    const author = comment.author_platform_user_id;
    if (!author || managed.has(author)) continue;
    const at = Date.parse(comment.published_at ?? comment.fetched_at);
    if (Number.isFinite(at) && at < sinceMs) continue;
    if (ctx.db.table('engagement_replies').findOne({ public_comment_id: comment.id })) continue;
    if (isSuppressed(ctx, author)) continue;
    const { kind, reason, detection } = classify(ctx, item);
    if (!kind) continue;
    const account = requireAccount(ctx, post.account_id);

    const draft =
      kind === 'answer'
        ? composeAnswer(ctx, post, detection)
        : { message: THANKS[account.account_type][hashIndex(comment.id, THANKS[account.account_type].length)], fact_refs: [] as FactRef[] };
    let cap = caps.get(account.id);
    if (!cap) {
      cap = await replyCapability(ctx, account.id);
      caps.set(account.id, cap);
    }
    const guards = runReplyGuards(ctx, { ...item, message: draft.message, fact_refs: draft.fact_refs }, { reply_capability: cap, human_approved: false });
    const blocking = guards.some((g) => !g.passed && g.blocking);
    const allPassed = guards.every((g) => g.passed);
    const now = ctx.clock.iso();

    let row: EngagementReply;
    try {
      row = ctx.db.tx(() => {
        const inserted = ctx.db.table('engagement_replies').insert({
          id: newId('eng'),
          dealer_id: dealerId,
          account_id: account.id,
          post_id: post.id,
          public_comment_id: comment.id,
          message: draft.message,
          fact_refs: draft.fact_refs,
          guard_results: guards,
          status: blocking ? 'BLOCKED' : 'READY_FOR_REVIEW',
          capability_status: cap.status,
          provider_message_id: null,
          created_at: now,
          updated_at: now,
        });
        ctx.audit.decision({
          agent: ENGAGEMENT_AGENT,
          skill: 'engagement',
          decision_type: 'engagement_reply',
          subject_type: 'comment',
          subject_id: comment.id,
          inputs: { post_id: post.id, account_id: account.id, comment: comment.content, kind, reason },
          evidence: detection.evidence,
          output: { reply_id: inserted.id, message: draft.message, fact_refs: draft.fact_refs, status: inserted.status, guards },
          confidence: detection.intent.confidence ?? 0.6,
          engine: 'rules',
        });
        return inserted;
      });
    } catch (err) {
      if (/UNIQUE/i.test((err as Error)?.message ?? '')) continue; // drafted concurrently
      throw err;
    }
    if (allPassed) row = await deliver(ctx, row, item, 'READY_FOR_REVIEW');
    created.push(row);
  }
  return created;
}

/**
 * Human approval (optionally with an edited message). Guards are re-run; blocking failures → BLOCKED. Approved replies
 * are sent through the provider when possible, otherwise they stay APPROVED for a human to post in the app.
 */
export async function approveEngagementReply(ctx: AppContext, replyId: string, actor: string, editedMessage?: string): Promise<EngagementReply> {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const reply = ctx.db.table('engagement_replies').require(replyId);
  if (reply.status !== 'READY_FOR_REVIEW' && !(reply.status === 'BLOCKED' && editedMessage !== undefined)) {
    throw new PolicyError('invalid_reply_status', `状态为 ${reply.status} 的回复不能审批`, { reply_id: replyId, status: reply.status });
  }
  const message = (editedMessage ?? reply.message).trim();
  if (!message) throw new ValidationError('message', '回复内容不能为空');
  const item = itemFor(ctx, reply);
  const norm = normalizeText(message);
  // candidate facts: the stored refs plus freshly retrieved Dealer Brain facts for this comment (a previous blocked edit
  // may have dropped refs); only those whose claim literally appears in the approved text are declared
  const fresh = composeAnswer(ctx, item.post, classify(ctx, item).detection).fact_refs;
  const seen = new Set<string>();
  const refs = [...reply.fact_refs, ...fresh].filter((r) => {
    const key = `${r.kind}:${r.id}:${r.claim}`;
    if (seen.has(key) || !norm.includes(normalizeText(r.claim))) return false;
    seen.add(key);
    return true;
  });
  const cap = await replyCapability(ctx, reply.account_id);
  const guards = runReplyGuards(ctx, { ...item, message, fact_refs: refs, exclude_reply_id: reply.id }, { reply_capability: cap, human_approved: true });
  const blocking = guards.some((g) => !g.passed && g.blocking);
  const updated = ctx.db.tx(() => {
    const row = ctx.db.table('engagement_replies').update(replyId, {
      message,
      fact_refs: refs,
      guard_results: guards,
      status: blocking ? 'BLOCKED' : 'APPROVED',
      capability_status: cap.status,
    });
    ctx.audit.event({
      actor,
      action: blocking ? 'engagement_reply.blocked' : 'engagement_reply.approved',
      entity_type: 'engagement_reply',
      entity_id: replyId,
      details: { edited: editedMessage !== undefined, failed_guards: guards.filter((g) => !g.passed).map((g) => g.check) },
    });
    return row;
  });
  const canSend = !blocking && guards.find((g) => g.check === 'provider_capability')?.passed === true && !hadUnknownOutcome(ctx, replyId);
  return canSend ? deliver(ctx, updated, item, 'APPROVED') : updated;
}

/** Send an APPROVED reply through the provider (refused after an unknown outcome to avoid a duplicate public reply). */
export async function sendEngagementReply(ctx: AppContext, replyId: string): Promise<EngagementReply> {
  const reply = ctx.db.table('engagement_replies').require(replyId);
  if (reply.status !== 'APPROVED') throw new PolicyError('invalid_reply_status', `只能发送已审批的回复，当前为 ${reply.status}`, { reply_id: replyId });
  if (hadUnknownOutcome(ctx, replyId)) {
    throw new PolicyError('reply_outcome_unknown', '上一次回复结果未知，请到小红书核实后人工登记，避免重复回复', { reply_id: replyId });
  }
  const cap = await replyCapability(ctx, reply.account_id);
  const item = itemFor(ctx, reply);
  if (cap.status !== 'AVAILABLE' || !item.public_post.xsec_token) {
    throw new PolicyError('reply_capability_unavailable', `公开回复能力不可用（${cap.status}）：${cap.reason}`, { reply_id: replyId });
  }
  return deliver(ctx, reply, item, 'APPROVED');
}

/** A human posted the reply in the Xiaohongshu app. Blocking guards are re-checked first. */
export function markEngagementReplySentManually(ctx: AppContext, replyId: string, actor: string): EngagementReply {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const reply = ctx.db.table('engagement_replies').require(replyId);
  if (reply.status !== 'READY_FOR_REVIEW' && reply.status !== 'APPROVED') {
    throw new PolicyError('invalid_reply_status', `状态为 ${reply.status} 的回复不能登记为已发送`, { reply_id: replyId, status: reply.status });
  }
  const item = itemFor(ctx, reply);
  const guards = runReplyGuards(ctx, { ...item, message: reply.message, fact_refs: reply.fact_refs, exclude_reply_id: reply.id }, {
    reply_capability: { status: reply.capability_status, reason: 'manual send' },
    human_approved: true,
  });
  const failed = guards.filter((g) => !g.passed && g.blocking);
  if (failed.length > 0) {
    throw new PolicyError('reply_blocked', `回复未通过发送前检查：${failed.map((g) => g.detail).join('；')}`, { reply_id: replyId, checks: failed.map((g) => g.check) });
  }
  return ctx.db.tx(() => {
    const row = ctx.db.table('engagement_replies').update(replyId, { status: 'SENT_MANUALLY', guard_results: guards });
    ctx.audit.event({ actor, action: 'engagement_reply.sent_manually', entity_type: 'engagement_reply', entity_id: replyId, details: { sent_by: actor, previous_status: reply.status } });
    return row;
  });
}

export function cancelEngagementReply(ctx: AppContext, replyId: string, actor: string, reason: string): EngagementReply {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  if (!reason?.trim()) throw new ValidationError('reason', 'required');
  const reply = ctx.db.table('engagement_replies').require(replyId);
  if (reply.status === 'SENT' || reply.status === 'SENT_MANUALLY' || reply.status === 'CANCELLED') {
    throw new PolicyError('invalid_reply_status', `状态为 ${reply.status} 的回复不能取消`, { reply_id: replyId, status: reply.status });
  }
  return ctx.db.tx(() => {
    const row = ctx.db.table('engagement_replies').update(replyId, { status: 'CANCELLED' });
    ctx.audit.event({ actor, action: 'engagement_reply.cancelled', entity_type: 'engagement_reply', entity_id: replyId, details: { reason: reason.trim(), previous_status: reply.status } });
    return row;
  });
}

export const skill = defineSkill<{ dealer_id: string }, EngagementReply[]>({
  name: 'engagement',
  category: 'content',
  agent: 'publishing-agent',
  description:
    '互动运营：为自有已发布笔记下的新评论起草公开回复——买家提问只用Dealer Brain核实过的事实作答并引导私信/留资卡，纯夸赞简短致谢；营销号、拒绝、勿扰用户与自有账号不回复；发送前执行勿扰、账号健康、事实、平台规则、重复与审批检查。',
  input: v.object({ dealer_id: v.string({ min: 1 }) }),
  run(ctx, input) {
    return draftEngagementReplies(ctx, input.dealer_id);
  },
});
