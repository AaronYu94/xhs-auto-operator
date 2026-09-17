/**
 * Lead Research (spec §4 "public profiles/context when accessible", ARCHITECTURE §8 B1).
 *
 * Reads the lead's PUBLIC Xiaohongshu profile through the provider (only when `read_public_profile` is
 * AVAILABLE), classifies authenticity from real profile data (dealer/sales/industry accounts vs verified
 * local users), captures purchase signals from the user's recent public notes, and re-scores the lead.
 * When the capability or the profile is unavailable it records the skip and never fabricates profile data.
 */
import type { AppContext } from '../../../app/context.ts';
import { dedupeEvidence } from '../../../core/evidence.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { normalizeText } from '../../../core/text.ts';
import { DAY_MS, DEFAULT_TZ } from '../../../core/time.ts';
import type { CapabilityStatus, Evidence, Lead, LeadStage } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { findBrands, provinceOfIp } from '../../../domain/automotive-lexicon.ts';
import { buildDealerProfile } from '../../../domain/dealer-profile.ts';
import type { XhsUserProfile } from '../../../providers/xhs/types.ts';
import { STAGE_INDEX, isSuppressed, refreshNextAction, transitionLead } from '../../operations/crm/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';
import { getActiveAssignment, releaseAssignment } from '../account-assignment/index.ts';
import { detectIntentRules } from '../intent-detection/nlu.ts';
import { SIGNAL_FUTURE_TOLERANCE_MS, resolveSignalTime, upsertLeadFromSignal } from '../lead-deduplication/index.ts';
import { AUTHENTICITY_SCALE, authenticityFromEvidence, scoreLead } from '../lead-scoring/index.ts';

const AGENT = 'lead-research-agent';
const SKILL = 'lead-research';
const ACTOR = `agent:${AGENT}`;

/** Recent notes older than this are not current purchase intent (the §5 recency factor gives them 0 points). */
export const STALE_NOTE_DAYS = 90;

export interface LeadResearchResult {
  lead_id: string;
  status: 'researched' | 'skipped';
  reason: string;
  authenticity: { score: number; reasons: string[] };
  added_signals: number;
  industry_account: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Industry / dealer-sales account detection
// ─────────────────────────────────────────────────────────────────────────────

/** Nickname / bio phrases that identify dealer, sales, used-car or broker accounts (never acquisition leads). */
export const INDUSTRY_KEYWORDS = [
  '4S店',
  '销售顾问',
  '汽车顾问',
  '车商',
  '二手车',
  '收车',
  '车行',
  '置换热线',
  '经纪人',
  '买车找我',
  '私信报价',
  '底价',
] as const;
export type IndustryKeyword = (typeof INDUSTRY_KEYWORDS)[number];

export const INDUSTRY_EVIDENCE_LABEL = '疑似车商/销售账号';

export interface IndustryDetection {
  industry: boolean;
  keywords: string[];
  /** `industry_account` evidence quoting the matching bio clause (or nickname clause) verbatim */
  evidence: Evidence | null;
}

const CLAUSE_SPLIT_RE = /[｜|,，。.!！?？;；、\n\r\t]+/u;

// Context rules run on the NFKC-normalized, lower-cased clause that contains the keyword. Several keywords are also
// everyday words for buyers on Xiaohongshu (房产经纪人, 保险销售顾问, "4S店踩坑记录", "求底价", "卖了二手车",
// drivers who "收车" after a shift); closing such a buyer as LOST would silently lose a real lead.
/** Employment at a store: turns even a review-looking 4S店 clause into a dealer account. */
const STORE_OCCUPATION_RE = /销售|顾问|经理|店长|总监|主管|在职|上班|从业|员工|老兵|内部/u;
/** A consumer's experience with a 4S store (reviews, complaints, buying diaries). */
const STORE_CONSUMER_RE = /坑|套路|砍价|维权|投诉|吐槽|探店|体验|攻略|提车|买车记|购车记|记录|经历|日记|避雷|防骗/u;
const USED_CAR_TRADE_RE =
  /二手车(?:商|行|收购|回收|评估|检测|寄售|车源|批发|经纪|顾问|专营|直营|代理|精品|买卖|交易|销售|金融|置换)|(?:收售|收购|回收|寄售|专营|经营|批发|代卖|代售)二手车|高价收/u;
const USED_CAR_CONSUMER_RE = /卖了|卖掉|买了|想买|准备买|打算买|要买|在看|看看|开二手车|坑|攻略|车主|代步|入手/u;
const FLOOR_PRICE_SELLER_RE = /私信|私我|找我|问我|咨询|联系|全网|内部|团购|出售|直销|代办|报价|最低/u;
const FLOOR_PRICE_BUYER_RE = /求|问|想要|想拿|拿到|谈到|砍到|砍价|等|蹲|多少|吗|\?|有没有|能不能|哪里|哪家/u;
/** Automotive trade context required before 销售顾问 / 经纪人 count (both are common in property, insurance, beauty). */
const AUTO_TRADE_CONTEXT_RE = /汽车|二手车|4s|车行|车商|新车|试驾|车源|车辆|购车|豪车|车型/u;
const BIKE_SHOP_RE = /(?:自行|单|电动|摩托|电瓶)车行/u;
const DRIVER_SHIFT_RE = /司机|网约车|滴滴|出租|代驾|出车|下班|收工|回家/u;
const CAR_BUYING_TRADE_RE = /高价|上门|回收|评估|秒结|全款|长期|收售|二手|置换|车源/u;
/** Brand names that are common outside the car trade (小米 phones) only count together with an automotive word. */
const NON_AUTO_AMBIGUOUS_BRANDS: ReadonlySet<string> = new Set(['Xiaomi']);

function automotiveContext(clause: string, raw: string): boolean {
  if (AUTO_TRADE_CONTEXT_RE.test(clause)) return true;
  return findBrands(raw).some((b) => !NON_AUTO_AMBIGUOUS_BRANDS.has(b.brand));
}

/** When a clause containing the keyword really describes a trade account. */
const INDUSTRY_RULES: Readonly<Record<IndustryKeyword, (clause: string, raw: string) => boolean>> = {
  '4S店': (c) => STORE_OCCUPATION_RE.test(c) || !STORE_CONSUMER_RE.test(c),
  销售顾问: (c, raw) => automotiveContext(c, raw),
  汽车顾问: () => true,
  车商: () => true,
  二手车: (c) => USED_CAR_TRADE_RE.test(c) || !USED_CAR_CONSUMER_RE.test(c),
  收车: (c) => CAR_BUYING_TRADE_RE.test(c) || !DRIVER_SHIFT_RE.test(c),
  车行: (c) => !BIKE_SHOP_RE.test(c),
  置换热线: () => true,
  经纪人: (c, raw) => automotiveContext(c, raw),
  买车找我: () => true,
  私信报价: () => true,
  底价: (c) => FLOOR_PRICE_SELLER_RE.test(c) || !FLOOR_PRICE_BUYER_RE.test(c),
};

/**
 * Pure: industry / dealer-sales account detection on the public nickname + bio. A keyword counts only in a clause
 * whose context makes it a trade account (see INDUSTRY_RULES); the evidence quotes that clause verbatim (bio first).
 */
export function detectIndustryAccount(profile: { nickname?: string | null; bio?: string | null }): IndustryDetection {
  const fields = [typeof profile.bio === 'string' ? profile.bio : '', typeof profile.nickname === 'string' ? profile.nickname : ''];
  const keywords: string[] = [];
  let evidence: Evidence | null = null;
  for (const text of fields) {
    if (!text.trim()) continue;
    const clauses = text
      .split(CLAUSE_SPLIT_RE)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    for (const keyword of INDUSTRY_KEYWORDS) {
      const key = normalizeText(keyword);
      const hit = clauses.find((raw) => {
        const clause = normalizeText(raw);
        return clause.includes(key) && INDUSTRY_RULES[keyword](clause, raw);
      });
      if (!hit) continue;
      if (!keywords.includes(keyword)) keywords.push(keyword);
      if (!evidence) evidence = { code: 'industry_account', label: INDUSTRY_EVIDENCE_LABEL, quote: hit };
    }
  }
  return { industry: keywords.length > 0, keywords, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const provinceKey = (s: string): string => provinceOfIp(s) ?? normalizeText(s);
const evidenceKey = (e: Evidence): string => `${e.code}::${e.quote ? normalizeText(e.quote) : ''}`;

function requireLead(ctx: AppContext, leadId: string): Lead {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  return lead;
}

/** xsec_token observed with the most recent signal that came from a stored public note. */
function latestXsecToken(ctx: AppContext, leadId: string): string | null {
  const row = ctx.db.get<{ token: string }>(
    `SELECT p.xsec_token AS token FROM lead_signals s JOIN public_posts p ON p.id = s.public_post_id
     WHERE s.lead_id = ? AND p.xsec_token IS NOT NULL AND p.xsec_token <> ''
     ORDER BY s.signal_at DESC, s.created_at DESC LIMIT 1`,
    leadId,
  );
  return row?.token ?? null;
}

function noteAlreadyCaptured(ctx: AppContext, leadId: string, platformPostId: string): boolean {
  const row = ctx.db.get(
    `SELECT 1 AS hit FROM lead_signals s JOIN public_posts p ON p.id = s.public_post_id
     WHERE s.lead_id = ? AND p.platform_post_id = ? LIMIT 1`,
    leadId,
    platformPostId,
  );
  return row !== undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function suppressionReason(ctx: AppContext, lead: Lead): string | null {
  const suppression = isSuppressed(ctx, lead.platform_user_id, lead.platform);
  if (!lead.suppressed && !suppression) return null;
  return lead.suppression_reason ?? suppression?.reason ?? '用户在勿扰名单中';
}

interface SkipInput {
  lead: Lead;
  reason: string;
  capability?: { status: CapabilityStatus; reason: string } | null;
  xsecTokenUsed?: boolean;
}

function recordSkip(ctx: AppContext, input: SkipInput): LeadResearchResult {
  const authenticity = authenticityFromEvidence(input.lead.evidence);
  const industry = input.lead.evidence.some((e) => e.code === 'industry_account');
  ctx.audit.decision({
    agent: AGENT,
    skill: SKILL,
    decision_type: 'lead_research',
    subject_type: 'lead',
    subject_id: input.lead.id,
    inputs: {
      lead_id: input.lead.id,
      dealer_id: input.lead.dealer_id,
      platform_user_id: input.lead.platform_user_id,
      provider: { name: ctx.xhs.name, mode: ctx.xhs.mode },
      capability: input.capability ?? null,
      xsec_token_used: input.xsecTokenUsed ?? false,
      profile: null,
    },
    evidence: [],
    output: {
      status: 'skipped',
      reason: input.reason,
      authenticity,
      added_signals: 0,
      industry_account: industry,
    },
    confidence: 1,
    engine: 'rules',
  });
  return {
    lead_id: input.lead.id,
    status: 'skipped',
    reason: input.reason,
    authenticity,
    added_signals: 0,
    industry_account: industry,
  };
}

interface NoteOutcome {
  platform_post_id: string;
  title: string;
  outcome:
    | 'added'
    | 'duplicate'
    | 'not_purchase_signal'
    | 'already_captured'
    | 'other_author'
    | 'unknown_publish_time'
    | 'future_publish_time'
    | 'stale_note'
    | 'rejected';
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Research
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Research one lead's public profile. Provider calls happen first (no transaction is open while awaiting);
 * all persistence afterwards is synchronous.
 */
export async function researchLead(ctx: AppContext, leadId: string): Promise<LeadResearchResult> {
  const initial = requireLead(ctx, leadId);

  const suppressedBefore = suppressionReason(ctx, initial);
  if (suppressedBefore !== null)
    return recordSkip(ctx, { lead: initial, reason: `lead_suppressed: ${suppressedBefore}（不再读取其主页）` });

  let capability: { status: CapabilityStatus; reason: string };
  try {
    const report = await ctx.xhs.capabilities(null);
    const state = report.capabilities.read_public_profile;
    capability = { status: state.status, reason: state.reason };
  } catch (err) {
    return recordSkip(ctx, { lead: requireLead(ctx, leadId), reason: `UNAVAILABLE: capability check failed: ${errorMessage(err)}` });
  }
  if (capability.status !== 'AVAILABLE')
    return recordSkip(ctx, { lead: requireLead(ctx, leadId), reason: `${capability.status}: ${capability.reason}`, capability });

  const xsecToken = latestXsecToken(ctx, leadId);
  let profile: XhsUserProfile;
  try {
    const res = await ctx.xhs.getUserProfile({ platform_user_id: initial.platform_user_id, xsec_token: xsecToken }, null);
    if (!res.ok)
      return recordSkip(ctx, {
        lead: requireLead(ctx, leadId),
        reason: `${res.status}: ${res.reason}`,
        capability,
        xsecTokenUsed: xsecToken !== null,
      });
    profile = res.data;
  } catch (err) {
    return recordSkip(ctx, {
      lead: requireLead(ctx, leadId),
      reason: `UNAVAILABLE: profile request failed: ${errorMessage(err)}`,
      capability,
      xsecTokenUsed: xsecToken !== null,
    });
  }

  // ── everything below is synchronous ─────────────────────────────────────────
  const before = requireLead(ctx, leadId);
  // the user may have asked not to be contacted while the profile was being read: keep nothing from it
  const suppressedDuring = suppressionReason(ctx, before);
  if (suppressedDuring !== null)
    return recordSkip(ctx, {
      lead: before,
      reason: `lead_suppressed: ${suppressedDuring}（读取主页期间进入勿扰名单，未保存主页信息）`,
      capability,
      xsecTokenUsed: xsecToken !== null,
    });
  if (profile.platform_user_id !== before.platform_user_id)
    return recordSkip(ctx, {
      lead: before,
      reason: `profile_mismatch: provider returned profile ${profile.platform_user_id} for ${before.platform_user_id}`,
      capability,
      xsecTokenUsed: xsecToken !== null,
    });

  const dealer = getDealer(ctx, before.dealer_id);
  const sourceRef = `profile:${before.platform_user_id}`;
  const industry = detectIndustryAccount(profile);
  const ipLocation = typeof profile.ip_location === 'string' && profile.ip_location.trim() ? profile.ip_location.trim() : null;
  const ipProvince = provinceOfIp(ipLocation);
  const verifiedLocal = !industry.industry && ipProvince !== null && provinceKey(ipProvince) === provinceKey(dealer.province);

  const found: Evidence[] = [];
  if (industry.evidence) found.push({ ...industry.evidence, source_ref: sourceRef });
  if (verifiedLocal && ipLocation)
    found.push({ code: 'verified_local_user', label: `本地真实用户（IP属地 ${ipProvince}）`, quote: ipLocation, source_ref: sourceRef });

  let addedEvidence: string[] = [];
  let removedEvidence: string[] = [];
  ctx.db.tx(() => {
    const lead = requireLead(ctx, leadId);
    // local verification is re-evaluated on every research (IP 属地 changes, the lead may have moved dealer);
    // industry evidence stays: it explains why the lead was closed
    const kept = lead.evidence.filter((e) => !(e.code === 'verified_local_user' && e.source_ref === sourceRef));
    const evidence = dedupeEvidence([...kept, ...found]);
    const beforeKeys = new Set(lead.evidence.map(evidenceKey));
    const afterKeys = new Set(evidence.map(evidenceKey));
    addedEvidence = evidence.filter((e) => !beforeKeys.has(evidenceKey(e))).map((e) => e.code);
    removedEvidence = lead.evidence.filter((e) => !afterKeys.has(evidenceKey(e))).map((e) => e.code);
    const patch: Partial<Lead> = {};
    if (addedEvidence.length > 0 || removedEvidence.length > 0) patch.evidence = evidence;
    // §10.2: a researched industry / sales account is classified DEALER_OR_SALES, whatever its signals looked like
    if (industry.industry && lead.actor_type !== 'DEALER_OR_SALES') patch.actor_type = 'DEALER_OR_SALES';
    const profileUrl = profile.profile_url?.trim();
    if (!lead.profile_url && profileUrl) patch.profile_url = profileUrl;
    if (Object.keys(patch).length === 0) return;
    ctx.db.table('leads').update(lead.id, patch);
    ctx.audit.event({
      actor: ACTOR,
      action: 'lead.researched',
      entity_type: 'lead',
      entity_id: lead.id,
      details: {
        industry_account: industry.industry,
        industry_keywords: industry.keywords,
        verified_local_user: verifiedLocal,
        ip_location: ipLocation,
        added_evidence: addedEvidence,
        removed_evidence: removedEvidence,
        profile_url_set: patch.profile_url !== undefined,
      },
    });
  });

  // Industry / sales accounts are never acquisition leads: close them unless a sales conversation already exists,
  // and free the owning account (its undelivered outreach is cancelled) so nobody messages a trade account.
  let lead = requireLead(ctx, leadId);
  let assignmentReleased = false;
  if (industry.industry && !(lead.stage === 'WON' || lead.stage === 'LOST') && STAGE_INDEX[lead.stage] < STAGE_INDEX.CONTACTED) {
    transitionLead(ctx, leadId, 'LOST', { reason: 'industry_account', actor: ACTOR });
    if (getActiveAssignment(ctx, leadId)) {
      releaseAssignment(ctx, leadId, `${INDUSTRY_EVIDENCE_LABEL}（industry_account）`, ACTOR);
      assignmentReleased = true;
    }
    lead = requireLead(ctx, leadId);
  }

  const notes: NoteOutcome[] = [];
  let added = 0;
  if (!industry.industry) {
    const dealerProfile = buildDealerProfile(ctx, lead.dealer_id);
    const timezone = dealer.settings?.timezone || DEFAULT_TZ;
    const nowMs = ctx.clock.now().getTime();
    for (const note of profile.recent_notes ?? []) {
      const title = typeof note.title === 'string' ? note.title.trim() : '';
      if (!title) continue;
      const base = { platform_post_id: note.platform_post_id, title };
      const author = note.author?.platform_user_id;
      if (author && author !== lead.platform_user_id) {
        notes.push({ ...base, outcome: 'other_author', detail: author });
        continue;
      }
      if (noteAlreadyCaptured(ctx, leadId, note.platform_post_id)) {
        notes.push({ ...base, outcome: 'already_captured' });
        continue;
      }
      let signalAt: string | null = null;
      if (note.published_at) {
        try {
          signalAt = resolveSignalTime(note.published_at, timezone, 'recent_notes.published_at');
        } catch {
          signalAt = null;
        }
      }
      if (signalAt === null) {
        // an undated note would be scored as brand-new; never invent its recency
        notes.push({ ...base, outcome: 'unknown_publish_time' });
        continue;
      }
      const publishedMs = Date.parse(signalAt);
      if (publishedMs > nowMs + SIGNAL_FUTURE_TOLERANCE_MS) {
        notes.push({ ...base, outcome: 'future_publish_time', detail: signalAt });
        continue;
      }
      if (nowMs - publishedMs > STALE_NOTE_DAYS * DAY_MS) {
        notes.push({ ...base, outcome: 'stale_note', detail: signalAt });
        continue;
      }
      const detection = detectIntentRules(
        title,
        { source_type: 'profile', author_nickname: profile.nickname, ip_location: ipLocation },
        dealerProfile,
      );
      if (!detection.is_purchase_signal || detection.negative) {
        notes.push({ ...base, outcome: 'not_purchase_signal' });
        continue;
      }
      try {
        const current = requireLead(ctx, leadId);
        const res = upsertLeadFromSignal(ctx, {
          dealer_id: current.dealer_id,
          identity: {
            platform_user_id: current.platform_user_id,
            username: profile.nickname?.trim() || current.username,
            profile_url: profile.profile_url ?? current.profile_url,
          },
          signal: {
            source_type: 'profile',
            content: title,
            post_title: null,
            public_post_id: null,
            public_comment_id: null,
            signal_at: signalAt,
            detection,
          },
        });
        if (res.signal) {
          added += 1;
          notes.push({ ...base, outcome: 'added', detail: res.signal.id });
        } else notes.push({ ...base, outcome: 'duplicate' });
      } catch (err) {
        if (!(err instanceof PolicyError || err instanceof ValidationError)) throw err;
        notes.push({ ...base, outcome: 'rejected', detail: err.code });
      }
    }
  }

  const scoreRow = scoreLead(ctx, leadId);
  lead = refreshNextAction(ctx, leadId);

  const industryOnLead = industry.industry || lead.evidence.some((e) => e.code === 'industry_account');
  const authenticity = authenticityFromEvidence(lead.evidence);
  const reasonParts: string[] = [];
  if (industry.industry) reasonParts.push(`${INDUSTRY_EVIDENCE_LABEL}（命中：${industry.keywords.join('、')}）`);
  else if (verifiedLocal) reasonParts.push(`IP属地 ${ipProvince} 与门店所在省份一致，判定为本地真实用户`);
  else
    reasonParts.push(
      `未发现车商/营销特征；IP属地 ${ipLocation ?? '未公开'}${ipProvince && !verifiedLocal ? `（非门店所在省份 ${dealer.province}）` : ''}`,
    );
  if (assignmentReleased) reasonParts.push('已释放负责账号并取消未发送私信');
  if (added > 0) reasonParts.push(`新增 ${added} 条主页笔记购车信号`);
  const reason = reasonParts.join('；');
  const stageAfter: LeadStage = lead.stage;

  ctx.audit.decision({
    agent: AGENT,
    skill: SKILL,
    decision_type: 'lead_research',
    subject_type: 'lead',
    subject_id: leadId,
    inputs: {
      lead_id: leadId,
      dealer_id: lead.dealer_id,
      provider: { name: ctx.xhs.name, mode: ctx.xhs.mode },
      capability,
      xsec_token_used: xsecToken !== null,
      profile: {
        platform_user_id: profile.platform_user_id,
        nickname: profile.nickname,
        bio: profile.bio,
        ip_location: profile.ip_location,
        follower_count: profile.follower_count,
        note_count: profile.note_count,
        recent_note_titles: (profile.recent_notes ?? []).map((n) => n.title),
      },
    },
    evidence: found,
    output: {
      status: 'researched',
      reason,
      industry_account: industryOnLead,
      industry_keywords: industry.keywords,
      verified_local_user: verifiedLocal,
      ip_province: ipProvince,
      dealer_province: dealer.province,
      authenticity,
      added_evidence: addedEvidence,
      removed_evidence: removedEvidence,
      assignment_released: assignmentReleased,
      added_signals: added,
      notes,
      stage_before: before.stage,
      stage_after: stageAfter,
      score_before: before.score,
      score_after: scoreRow.score,
      tier_after: scoreRow.tier,
      lead_score_id: scoreRow.id,
    },
    confidence: industry.industry ? 0.85 : verifiedLocal ? 0.7 : 0.5,
    engine: 'rules',
  });

  return {
    lead_id: leadId,
    status: 'researched',
    reason,
    authenticity,
    added_signals: added,
    industry_account: industryOnLead,
  };
}

export const skill = defineSkill<{ lead_id: string }, LeadResearchResult>({
  name: 'lead-research',
  category: 'acquisition',
  agent: 'lead-research-agent',
  description:
    '线索研究：在 read_public_profile 可用时读取用户公开主页，结合上下文识别车商/销售等行业账号（关闭线索并释放负责账号）与本地真实用户（IP属地），从本人近90天主页笔记补充购车信号并重新评分；能力不可用时如实跳过、绝不编造资料。',
  input: v.object({ lead_id: v.string({ min: 1, max: 200 }) }),
  run: (ctx, input) => researchLead(ctx, input.lead_id),
  validateOutput(output) {
    const score = output?.authenticity?.score;
    if (typeof score !== 'number' || score < 0 || score > AUTHENTICITY_SCALE)
      throw new Error(`lead-research: authenticity must be on the 0..${AUTHENTICITY_SCALE} scale`);
    if (output.status === 'skipped' && output.added_signals !== 0)
      throw new Error('lead-research: a skipped research cannot add signals');
  },
});
