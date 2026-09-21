/**
 * Account Brain (spec §1): each Xiaohongshu account's identity, persona, positioning, performance,
 * content history, lead ownership and health — computed from real tables, never static.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { round } from '../../../core/text.ts';
import { addDays } from '../../../core/time.ts';
import type {
  AccountHealth,
  AccountPersona,
  AccountType,
  ApprovalPolicy,
  ContentPillar,
  Post,
  XhsAccount,
} from '../../../core/types.ts';
import { v, type Validator } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { contentMixValidator, getDealer } from '../dealer-brain/index.ts';
import { stableStringify } from '../dealer-brain/shared.ts';

export interface AccountPerformance {
  posts_published_30d: number;
  avg_engagement_30d: number;
  leads_owned_active: number;
  outreach_sent_30d: number;
  replies_30d: number;
  reply_rate_30d: number;
  appointments_90d: number;
  won_90d: number;
  conversion_rate_90d: number;
  negative_feedback_7d: number;
}

export interface AccountBrain {
  account: XhsAccount;
  persona: AccountPersona;
  health: AccountHealth | null;
  performance: AccountPerformance;
  recent_posts: Post[];
}

export interface OutreachPolicy {
  policy: ApprovalPolicy;
  daily_limit: number;
  min_interval_minutes: number;
  max_unanswered_touches: number;
  follow_up_after_days: number;
  auto_send_min_score: number;
  timezone: string;
}

const SENT_STATUSES = `('SENT', 'SENT_MANUALLY')`;
const RECENT_POSTS_LIMIT = 10;

export function requireAccount(ctx: AppContext, accountId: string): XhsAccount {
  const account = ctx.db.table('xhs_accounts').get(accountId);
  if (!account) throw new NotFoundError('xhs_account', accountId);
  return account;
}

const num = (row: Record<string, unknown> | undefined, key = 'n'): number => {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
};

/** Distinct platform users who asked not to be contacted within the window, attributed to this account's sent outreach. */
function negativeFeedbackUsers(ctx: AppContext, accountId: string, fromIso: string, toIso: string): Set<string> {
  const users = new Set<string>();
  const contactedBy = (platformUserId: string): boolean =>
    ctx.db.get(
      `SELECT 1 AS n FROM leads l JOIN outreach o ON o.lead_id = l.id
       WHERE l.platform_user_id = ? AND o.account_id = ? AND o.status IN ${SENT_STATUSES} LIMIT 1`,
      platformUserId,
      accountId,
    ) !== undefined;

  const suppressions = ctx.db.all<{ platform_user_id: string }>(
    `SELECT DISTINCT platform_user_id FROM contact_suppressions WHERE created_at >= ? AND created_at <= ?`,
    fromIso,
    toIso,
  );
  for (const s of suppressions) if (contactedBy(s.platform_user_id)) users.add(s.platform_user_id);

  const events = ctx.db
    .table('audit_events')
    .query(`action = 'contact.suppressed' AND created_at >= ? AND created_at <= ?`, [fromIso, toIso]);
  for (const e of events) {
    const details = e.details ?? {};
    const candidates = new Set<string>();
    if (typeof details.platform_user_id === 'string') candidates.add(details.platform_user_id);
    const leadIds: string[] = [];
    if (e.entity_type === 'lead') leadIds.push(e.entity_id);
    if (typeof details.lead_id === 'string') leadIds.push(details.lead_id);
    if (Array.isArray(details.leads_updated)) for (const id of details.leads_updated) if (typeof id === 'string') leadIds.push(id);
    for (const id of leadIds) {
      const lead = ctx.db.table('leads').get(id);
      if (lead) candidates.add(lead.platform_user_id);
    }
    if (e.entity_type === 'contact_suppression') {
      const sup = ctx.db.table('contact_suppressions').get(e.entity_id);
      if (sup) candidates.add(sup.platform_user_id);
    }
    for (const userId of candidates) {
      if (users.has(userId)) continue;
      if (details.account_id === accountId || contactedBy(userId)) users.add(userId);
    }
  }
  return users;
}

/** Rolling 7d / 30d / 90d performance relative to ctx.clock. Empty history → zeros (never NaN). */
export function getAccountPerformance(ctx: AppContext, accountId: string): AccountPerformance {
  requireAccount(ctx, accountId);
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const since7 = addDays(now, -7).toISOString();
  const since30 = addDays(now, -30).toISOString();
  const since90 = addDays(now, -90).toISOString();
  const db = ctx.db;

  const posts = db
    .table('posts')
    .query(`account_id = ? AND status = 'PUBLISHED' AND published_at IS NOT NULL AND published_at >= ? AND published_at <= ?`, [
      accountId,
      since30,
      nowIso,
    ]);
  const engagement = posts.reduce((sum, p) => {
    const m = p.metrics ?? { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 };
    return sum + (m.likes ?? 0) + (m.collects ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
  }, 0);

  const leadsOwnedActive = num(
    db.get(
      `SELECT COUNT(DISTINCT a.lead_id) AS n FROM lead_assignments a JOIN leads l ON l.id = a.lead_id
       WHERE a.account_id = ? AND a.active = 1 AND l.stage NOT IN ('WON', 'LOST') AND l.suppressed = 0`,
      accountId,
    ),
  );

  const outreachSent = num(
    db.get(
      `SELECT COUNT(*) AS n FROM outreach WHERE account_id = ? AND status IN ${SENT_STATUSES}
       AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ?`,
      accountId,
      since30,
      nowIso,
    ),
  );

  const contactStats = db.get(
    `SELECT COUNT(*) AS contacted,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM conversations cv JOIN conversation_messages m ON m.conversation_id = cv.id
              WHERE cv.account_id = ? AND cv.lead_id = c.lead_id AND m.direction = 'inbound'
                AND m.created_at >= c.first_sent AND m.created_at <= ?
            ) THEN 1 ELSE 0 END) AS replied
     FROM (SELECT lead_id, MIN(sent_at) AS first_sent FROM outreach
           WHERE account_id = ? AND status IN ${SENT_STATUSES} AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ?
           GROUP BY lead_id) c`,
    accountId,
    nowIso,
    accountId,
    since30,
    nowIso,
  );
  const contacted = num(contactStats, 'contacted');
  const repliedContacted = num(contactStats, 'replied');

  const replies = num(
    db.get(
      `SELECT COUNT(DISTINCT cv.id) AS n FROM conversations cv JOIN conversation_messages m ON m.conversation_id = cv.id
       WHERE cv.account_id = ? AND m.direction = 'inbound' AND m.created_at >= ? AND m.created_at <= ?`,
      accountId,
      since30,
      nowIso,
    ),
  );

  const appointments = num(
    db.get(
      `SELECT COUNT(*) AS n FROM appointments WHERE account_id = ? AND status <> 'cancelled' AND created_at >= ? AND created_at <= ?`,
      accountId,
      since90,
      nowIso,
    ),
  );

  const won = num(
    db.get(
      `SELECT COUNT(DISTINCT c.lead_id) AS n FROM conversions c
       WHERE c.outcome = 'won' AND c.occurred_at >= ? AND c.occurred_at <= ?
         AND (c.account_id = ? OR (c.account_id IS NULL AND EXISTS (
           SELECT 1 FROM lead_assignments a WHERE a.lead_id = c.lead_id AND a.account_id = ?
             AND a.assigned_at <= c.occurred_at AND (a.released_at IS NULL OR a.released_at >= c.occurred_at))))`,
      since90,
      nowIso,
      accountId,
      accountId,
    ),
  );

  const ownedIn90 = num(
    db.get(
      `SELECT COUNT(DISTINCT lead_id) AS n FROM lead_assignments
       WHERE account_id = ? AND assigned_at <= ? AND (released_at IS NULL OR released_at >= ?)`,
      accountId,
      nowIso,
      since90,
    ),
  );
  const denominator = Math.max(ownedIn90, won);

  return {
    posts_published_30d: posts.length,
    avg_engagement_30d: posts.length > 0 ? round(engagement / posts.length, 2) : 0,
    leads_owned_active: leadsOwnedActive,
    outreach_sent_30d: outreachSent,
    replies_30d: replies,
    reply_rate_30d: contacted > 0 ? round(repliedContacted / contacted, 4) : 0,
    appointments_90d: appointments,
    won_90d: won,
    conversion_rate_90d: denominator > 0 ? round(won / denominator, 4) : 0,
    negative_feedback_7d: negativeFeedbackUsers(ctx, accountId, since7, nowIso).size,
  };
}

const DEFAULT_POSITIONING: Record<AccountType, { tone: string; positioning: string; mix: Partial<Record<ContentPillar, number>> }> = {
  official: {
    tone: '官方、稳重、信息准确',
    positioning: '门店官方信息发布：新车到店、限时政策与门店活动',
    mix: { dealer_event: 0.3, price_offer: 0.25, inventory_showcase: 0.2, model_review: 0.15, ownership_tips: 0.1 },
  },
  salesperson: {
    tone: '亲切、真诚、像朋友一样给建议',
    positioning: '一线销售视角的选车、提车与用车经验分享',
    mix: { buying_guide: 0.3, customer_story: 0.2, price_offer: 0.2, comparison: 0.2, inventory_showcase: 0.1 },
  },
  model_specialist: {
    tone: '专业、理性、数据导向',
    positioning: '单一车型的深度解读与对比测评',
    mix: { model_review: 0.4, comparison: 0.3, ownership_tips: 0.2, buying_guide: 0.1 },
  },
  local_guide: {
    tone: '热心、本地化、攻略感强',
    positioning: '本地购车攻略：上牌、补贴、试驾与看车流程',
    mix: { buying_guide: 0.4, local_life: 0.3, finance_explainer: 0.2, dealer_event: 0.1 },
  },
  customer_story: {
    tone: '温暖、真实、故事化',
    positioning: '真实车主提车与用车故事',
    mix: { customer_story: 0.6, ownership_tips: 0.2, local_life: 0.2 },
  },
};

/** Returns the account's persona; an account created without one gets a persisted account-type baseline. */
export function ensurePersona(ctx: AppContext, account: XhsAccount): AccountPersona {
  const personas = ctx.db.table('account_personas');
  const existing = personas.findOne({ account_id: account.id });
  if (existing) return existing;
  const dealer = getDealer(ctx, account.dealer_id);
  const base = DEFAULT_POSITIONING[account.account_type];
  return ctx.db.tx(() => {
    const persona = personas.insert({
      id: newId('per'),
      account_id: account.id,
      persona_name: account.nickname,
      bio: '',
      tone: base.tone,
      voice_rules: [],
      target_customers: [],
      focus_brands: [...dealer.brands],
      focus_models: [],
      content_positioning: base.positioning,
      content_mix: base.mix,
      goals: {},
      signature_phrases: [],
      taboo_topics: [],
      updated_at: ctx.clock.iso(),
    });
    ctx.audit.event({
      actor: 'system',
      action: 'account.persona_created',
      entity_type: 'xhs_account',
      entity_id: account.id,
      details: { persona_id: persona.id, basis: `account_type:${account.account_type}` },
    });
    return persona;
  });
}

function latestHealth(ctx: AppContext, accountId: string): AccountHealth | null {
  return ctx.db.table('account_health').findOne({ account_id: accountId }, { orderBy: 'date DESC, computed_at DESC' }) ?? null;
}

function recentPosts(ctx: AppContext, accountId: string): Post[] {
  const table = ctx.db.table('posts');
  return ctx.db
    .all(
      `SELECT * FROM posts WHERE account_id = ?
       ORDER BY COALESCE(published_at, scheduled_for, created_at) DESC, created_at DESC LIMIT ${RECENT_POSTS_LIMIT}`,
      accountId,
    )
    .map((row) => table.decode(row));
}

export function getAccountBrain(ctx: AppContext, accountId: string): AccountBrain {
  const account = requireAccount(ctx, accountId);
  return {
    account,
    persona: ensurePersona(ctx, account),
    health: latestHealth(ctx, accountId),
    performance: getAccountPerformance(ctx, accountId),
    recent_posts: recentPosts(ctx, accountId),
  };
}

/** The live fleet: accounts removed from it are excluded (their rows only carry history). */
export function listFleet(ctx: AppContext, q: { dealer_id?: string; group_id?: string } = {}): AccountBrain[] {
  const where: { dealer_id?: string; group_id?: string; removed_at: null } = { removed_at: null };
  if (q.dealer_id) where.dealer_id = q.dealer_id;
  if (q.group_id) where.group_id = q.group_id;
  return ctx.db
    .table('xhs_accounts')
    .findMany(where, { orderBy: 'dealer_id ASC, created_at ASC, nickname ASC' })
    .map((account) => getAccountBrain(ctx, account.id));
}

/** Dealer settings with non-null account overrides applied. */
export function effectiveOutreachPolicy(ctx: AppContext, accountId: string): OutreachPolicy {
  const account = requireAccount(ctx, accountId);
  const s = getDealer(ctx, account.dealer_id).settings;
  return {
    policy: account.outreach_approval_policy ?? s.outreach_approval_policy,
    daily_limit: account.daily_outreach_limit ?? s.daily_outreach_limit,
    min_interval_minutes: s.min_outreach_interval_minutes,
    max_unanswered_touches: s.max_unanswered_touches,
    follow_up_after_days: s.follow_up_after_days,
    auto_send_min_score: s.auto_send_min_score,
    timezone: s.timezone,
  };
}

export function effectivePublishPolicy(
  ctx: AppContext,
  accountId: string,
): { policy: ApprovalPolicy; daily_limit: number; timezone: string } {
  const account = requireAccount(ctx, accountId);
  const s = getDealer(ctx, account.dealer_id).settings;
  return {
    policy: s.publish_approval_policy,
    daily_limit: account.daily_publish_limit ?? s.daily_publish_limit,
    timezone: s.timezone,
  };
}

const textList = v.array(v.string({ min: 1 }));

const personaPatchValidator: Validator<Partial<AccountPersona>> = (value, path = '') => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(path, 'expected object');
  const raw = value as Record<string, unknown>;
  for (const key of ['id', 'account_id', 'updated_at']) {
    if (key in raw && raw[key] !== undefined) throw new ValidationError(path ? `${path}.${key}` : key, 'field is read-only');
  }
  const allowed = new Set([
    'persona_name',
    'bio',
    'tone',
    'voice_rules',
    'target_customers',
    'focus_brands',
    'focus_models',
    'content_positioning',
    'content_mix',
    'goals',
    'signature_phrases',
    'taboo_topics',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key) && raw[key] !== undefined) throw new ValidationError(path ? `${path}.${key}` : key, 'unknown persona field');
  }
  return v.object({
    persona_name: v.optional(v.string({ min: 1 })),
    bio: v.optional(v.string()),
    tone: v.optional(v.string({ min: 1 })),
    voice_rules: v.optional(textList),
    target_customers: v.optional(textList),
    focus_brands: v.optional(textList),
    focus_models: v.optional(textList),
    content_positioning: v.optional(v.string({ min: 1 })),
    content_mix: v.optional(contentMixValidator),
    goals: v.optional(
      v.object({
        monthly_qualified_leads: v.optional(v.number({ int: true, min: 0 })),
        monthly_posts: v.optional(v.number({ int: true, min: 0 })),
        monthly_appointments: v.optional(v.number({ int: true, min: 0 })),
      }),
    ),
    signature_phrases: v.optional(textList),
    taboo_topics: v.optional(textList),
  })(value, path) as Partial<AccountPersona>;
};

/** Validated partial persona update; writes audit event 'account.persona_updated' with before/after of changed fields. */
export function updatePersona(ctx: AppContext, accountId: string, patch: Partial<AccountPersona>, actor: string): AccountPersona {
  const account = requireAccount(ctx, accountId);
  const clean = personaPatchValidator(patch, 'patch');
  const current = ensurePersona(ctx, account);
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const update: Record<string, unknown> = {};
  for (const [key, after] of Object.entries(clean)) {
    const before = (current as unknown as Record<string, unknown>)[key];
    if (stableStringify(before) === stableStringify(after)) continue;
    changes[key] = { before, after };
    update[key] = after;
  }
  if (Object.keys(update).length === 0) return current;
  return ctx.db.tx(() => {
    const updated = ctx.db.table('account_personas').update(current.id, update as Partial<AccountPersona>);
    ctx.audit.event({
      actor,
      action: 'account.persona_updated',
      entity_type: 'xhs_account',
      entity_id: accountId,
      details: { persona_id: current.id, changed_fields: Object.keys(update), changes },
    });
    return updated;
  });
}

export const skill = defineSkill<{ account_id: string }, AccountBrain>({
  name: 'account-brain',
  category: 'operations',
  agent: 'account-strategy-agent',
  description: '读取单个小红书账号的账号大脑：身份、人设定位、近期内容、线索归属、7/30/90天真实表现与最新健康度。',
  input: v.object({ account_id: v.string({ min: 1 }) }),
  run(ctx, input) {
    return getAccountBrain(ctx, input.account_id);
  },
});
