/**
 * Content planning (B3, spec §15/§20): for every active, operable account of a dealer build the account strategy
 * and lay out PLANNED post slots for the period — pillar allocation by strategy weights (largest remainder), model
 * rotation over focus models (goal models first), persona/account-type specific angles — de-cannibalized across the
 * dealer's accounts: the same (model, pillar) is never scheduled on two accounts within 3 days and the same topic
 * key never twice within one period length (existing planned/published posts included).
 * Rolling plans (the daily workflow plans "tomorrow + 7 days" every day) are safe: live posts of the account already
 * in the period count toward its cadence, a day holds at most one post per account, and no overlapping plan period
 * of the account ever exceeds its own cadence.
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { DAY_MS, addDaysToKey, localDateKey } from '../../../core/time.ts';
import { CONTENT_PILLARS, type AccountType, type ContentPillar, type ContentPlan, type Evidence, type Post, type XhsAccount } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { getBrandInfo, getModelInfo } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { effectivePublishPolicy, ensurePersona } from '../../operations/account-brain/index.ts';
import { isAccountOperable } from '../../operations/account-health/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { dealerTz, isValidDateValue } from '../../operations/dealer-brain/shared.ts';
import { buildAccountStrategy, resolveGoal, type AccountStrategy } from '../account-strategy/index.ts';

export const SKILL_NAME = 'content-planning';
export const PLANNING_AGENT = 'account-strategy-agent';
export const DEFAULT_PLAN_DAYS = 7;
export const MAX_PLAN_DAYS = 31;
export const DEFAULT_MONTHLY_POSTS = 12;
export const MIN_POSTS_PER_ACCOUNT = 2;
/** The same (model, pillar) may not be scheduled on two accounts when their dates are this many days apart or closer. */
export const CANNIBALIZATION_WINDOW_DAYS = 3;
/** Planning priority: specialists and salespeople claim their focus models before broad accounts. */
export const PLANNING_ORDER: Readonly<Record<AccountType, number>> = {
  model_specialist: 0,
  salesperson: 1,
  official: 2,
  local_guide: 3,
  customer_story: 4,
};
const GENERAL_MODEL_KEY = 'general';

// ─────────────────────────────────────────────────────────────────────────────
// Angle library (persona- and account-type specific)
// ─────────────────────────────────────────────────────────────────────────────

/** `{city}` / `{brand}` are filled from the account; `{ev, ice}` variants depend on the model's powertrain. */
export type AngleTemplate = string | { ev: string; ice: string };

export const ANGLE_LIBRARY: Readonly<Record<AccountType, Readonly<Record<ContentPillar, readonly AngleTemplate[]>>>> = {
  official: {
    model_review: ['官方车型亮点解读', '新车到店静态详解', '{brand}官方配置清单解读'],
    price_offer: ['官方权益解读', '当月限时政策汇总', '购车权益有效期提醒'],
    inventory_showcase: ['现车到店实拍', '门店现车清单', '在途车辆到店预告'],
    comparison: ['同级配置官方对比', '版本差异官方说明', '选配建议官方版'],
    buying_guide: ['官方购车流程说明', '到店看车预约指南', '交付流程全解析'],
    finance_explainer: ['官方金融方案解读', '置换政策官方说明', '贷款办理材料清单'],
    customer_story: ['交车仪式记录', '老车主回店故事', '车主活动回顾'],
    local_life: ['{city}门店周边自驾路线', '{city}城市出行场景', '门店服务日常'],
    dealer_event: ['门店活动', '试驾季活动报名', '车主沙龙预告'],
    ownership_tips: ['官方保养提醒', '质保政策说明', '换季用车提示'],
  },
  salesperson: {
    model_review: ['销售视角配置怎么选', '到店看车实拍', '客户最常问的5个问题'],
    price_offer: ['销售视角真实报价拆解', '这个月政策怎么用最划算', '优惠之外还要算的费用'],
    inventory_showcase: ['到店看车实拍', '今日到店现车', '热门颜色现车盘点'],
    comparison: ['客户纠结两款车怎么选', '版本差价值不值', '同价位竞品真实对比'],
    buying_guide: ['买车避坑清单', '第一次买{brand}注意事项', '谈车流程一次讲清'],
    finance_explainer: ['贷款还是全款怎么算', '置换流程销售讲解', '首付月供怎么搭配'],
    customer_story: ['帮客户提车的故事', '客户选车纠结记录', '客户回访真实反馈'],
    local_life: ['{city}上下班通勤用车', '{city}周末自驾推荐', '销售的一天'],
    dealer_event: ['店里周末活动预告', '试驾活动邀约', '交车日现场'],
    ownership_tips: ['新车提车检查清单', '首保注意事项', '用车省钱小技巧'],
  },
  model_specialist: {
    model_review: ['深度技术拆解', { ev: '续航实测', ice: '油耗实测' }, '底盘与操控解析'],
    price_offer: ['各版本配置价格梳理', '优惠后的购置成本解析', '选装包值不值'],
    inventory_showcase: ['实车细节图鉴', '版本外观内饰差异实拍', '颜色搭配实拍'],
    comparison: ['竞品参数横评', '同级车型实测对比', '版本对比数据表'],
    buying_guide: ['版本选择决策树', '适合人群分析', '选配避坑'],
    finance_explainer: ['用车成本测算', { ev: '电车与油车用车成本对比', ice: '保养与油费成本测算' }, '金融方案成本对比'],
    customer_story: ['车主长期用车数据', '车主使用记录', '用车一年数据回顾'],
    local_life: [{ ev: '{city}充电地图', ice: '{city}周边自驾路线' }, '{city}城市通勤实测', '高架路况驾驶体验'],
    dealer_event: ['技术讲解会预告', '深度试驾活动', '车型品鉴会'],
    ownership_tips: [{ ev: '冬季续航保持技巧', ice: '保养周期详解' }, '驾驶辅助使用技巧', '车机功能隐藏玩法'],
  },
  local_guide: {
    model_review: ['{city}路况实测体验', '{city}人买这台车合适吗', '本地车主口碑整理'],
    price_offer: ['{city}买车政策汇总', '{city}购车补贴怎么领', '本地门店政策对比'],
    inventory_showcase: ['{city}门店看车实拍', '本地现车情况整理', '到店看车路线'],
    comparison: ['本地4S店对比', '{city}通勤选哪台', '同价位车型本地实测对比'],
    buying_guide: ['{city}买车避坑', '{city}上牌流程攻略', '到店前必看清单'],
    finance_explainer: ['{city}置换补贴攻略', '本地贷款办理流程', '买车费用明细清单'],
    customer_story: ['{city}车主提车故事', '新{city}人第一台车', '本地车主用车分享'],
    local_life: ['{city}周末自驾路线', '{city}充电与停车攻略', '{city}城市出行指南'],
    dealer_event: ['{city}车展与门店活动汇总', '本地试驾活动攻略', '周末看车行程安排'],
    ownership_tips: ['{city}限行与停车须知', '本地保养维修攻略', '{city}雨季用车提醒'],
  },
  customer_story: {
    model_review: ['车主眼中的真实优缺点', '车主用车一年回访', '车主口碑合集'],
    price_offer: ['车主购车权益体验', '车主谈购车决策', '车主算过的用车账'],
    inventory_showcase: ['车主提车现场', '提车日交付实拍', '车主爱车细节'],
    comparison: ['车主为什么最终选了它', '车主换车前后对比', '车主试驾对比经历'],
    buying_guide: ['车主的选车经验', '过来人买车建议', '车主踩过的坑'],
    finance_explainer: ['车主分期购车经历', '车主置换经历分享', '车主选金融方案的考量'],
    customer_story: ['车主提车故事', '用车一年回访', '一家人的用车日常'],
    local_life: ['车主{city}周末出游', '车主通勤日常', '车主自驾游记'],
    dealer_event: ['车主活动回顾', '车主聚会纪实', '交车仪式故事'],
    ownership_tips: ['车主用车心得', '车主保养经验', '老车主给新车主的建议'],
  },
};

export interface AngleContext {
  account_type: AccountType;
  city: string;
  brand_zh: string;
  taboo_topics: readonly string[];
}

/** Concrete angles for a pillar and model, with persona taboo topics filtered out. */
export function anglesFor(ac: AngleContext, pillar: ContentPillar, model: string | null): string[] {
  const ev = model ? getModelInfo(model)?.powertrain === 'EV' : false;
  const taboo = ac.taboo_topics.map((t) => t.trim()).filter((t) => t.length >= 2);
  const out: string[] = [];
  for (const tpl of ANGLE_LIBRARY[ac.account_type][pillar]) {
    const raw = typeof tpl === 'string' ? tpl : ev ? tpl.ev : tpl.ice;
    const angle = raw.replaceAll('{city}', ac.city).replaceAll('{brand}', ac.brand_zh).trim();
    if (!angle || out.includes(angle)) continue;
    if (taboo.some((t) => angle.includes(t) || t.includes(angle))) continue;
    out.push(angle);
  }
  return out;
}

export const topicKey = (model: string | null, pillar: ContentPillar, angle: string) => `${model ?? GENERAL_MODEL_KEY}:${pillar}:${angle}`;

// ─────────────────────────────────────────────────────────────────────────────
// Slot arithmetic (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** posts = clamp(round(monthly_posts / 30 × days), 2, days) */
export function postsForPeriod(monthlyPosts: number | undefined, days: number): number {
  const n = Math.round(((monthlyPosts ?? DEFAULT_MONTHLY_POSTS) / 30) * days);
  return Math.min(days, Math.max(MIN_POSTS_PER_ACCOUNT, n));
}

/** n dates spread evenly (centred) over the period: offset_k = floor((k + ½) × days / n). */
export function spreadSlotDates(periodStart: string, days: number, n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(addDaysToKey(periodStart, Math.min(days - 1, Math.floor(((k + 0.5) * days) / n))));
  return out;
}

/** Largest-remainder allocation of n slots over weighted pillars (ties: remainder, weight, CONTENT_PILLARS order). */
export function allocatePillars(pillars: readonly { pillar: ContentPillar; weight: number }[], n: number): Map<ContentPillar, number> {
  const order = (p: ContentPillar) => CONTENT_PILLARS.indexOf(p);
  const total = pillars.reduce((s, p) => s + Math.max(0, p.weight), 0);
  const counts = new Map<ContentPillar, number>();
  if (n <= 0 || total <= 0) return counts;
  const quotas = pillars.map((p) => {
    const exact = (Math.max(0, p.weight) / total) * n;
    const floor = Math.floor(exact + 1e-9);
    return { pillar: p.pillar, weight: p.weight, floor, rem: Math.round((exact - floor) * 1e9) / 1e9 };
  });
  let assigned = 0;
  for (const q of quotas) {
    counts.set(q.pillar, q.floor);
    assigned += q.floor;
  }
  const ranked = [...quotas].sort((a, b) => b.rem - a.rem || b.weight - a.weight || order(a.pillar) - order(b.pillar));
  for (let i = 0; assigned < n; i = (i + 1) % ranked.length, assigned++) {
    counts.set(ranked[i].pillar, (counts.get(ranked[i].pillar) ?? 0) + 1);
  }
  for (const [p, c] of [...counts]) if (c === 0) counts.delete(p);
  return counts;
}

/** Order allocated pillars so the same pillar never runs twice in a row when avoidable. */
export function pillarSequence(counts: ReadonlyMap<ContentPillar, number>, weights: ReadonlyMap<ContentPillar, number>): ContentPillar[] {
  const remaining = new Map(counts);
  const total = [...counts.values()].reduce((s, c) => s + c, 0);
  const order = (p: ContentPillar) => CONTENT_PILLARS.indexOf(p);
  const seq: ContentPillar[] = [];
  let prev: ContentPillar | null = null;
  for (let i = 0; i < total; i++) {
    const candidates = [...remaining.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || (weights.get(b[0]) ?? 0) - (weights.get(a[0]) ?? 0) || order(a[0]) - order(b[0]));
    const pick = candidates.find(([p]) => p !== prev) ?? candidates[0];
    seq.push(pick[0]);
    remaining.set(pick[0], pick[1] - 1);
    prev = pick[0];
  }
  return seq;
}

export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / DAY_MS);
}

/** Calendar day a post occupies: its dealer-local publish day once published, else its slot date. */
export function postDay(post: Pick<Post, 'status' | 'published_at' | 'slot_date'>, tz: string): string {
  return post.status === 'PUBLISHED' && post.published_at ? localDateKey(new Date(post.published_at), tz) : post.slot_date;
}

/**
 * Pillars for `n` free slots of a period whose full cadence is `target` and whose existing posts already cover
 * `existing` pillars: largest remainder over each pillar's unmet share of the cadence (equals `allocatePillars` when
 * nothing exists yet); when existing posts already cover every share, the plain weights decide.
 */
export function allocateRemainingPillars(
  pillars: readonly { pillar: ContentPillar; weight: number }[],
  target: number,
  existing: readonly ContentPillar[],
  n: number,
): Map<ContentPillar, number> {
  if (n <= 0) return new Map();
  const total = pillars.reduce((s, p) => s + Math.max(0, p.weight), 0);
  if (total <= 0) return new Map();
  const covered = new Map<ContentPillar, number>();
  for (const p of existing) covered.set(p, (covered.get(p) ?? 0) + 1);
  const size = Math.max(target, n + existing.length);
  const deficits = pillars.map((p) => ({ pillar: p.pillar, weight: Math.max(0, (Math.max(0, p.weight) / total) * size - (covered.get(p.pillar) ?? 0)) }));
  return deficits.some((d) => d.weight > 1e-9) ? allocatePillars(deficits, n) : allocatePillars(pillars, n);
}

/** The allowed day nearest to `day` within [start, end] (the later day first on ties), or null. */
export function nearestAllowedDay(day: string, start: string, end: string, ok: (day: string) => boolean): string | null {
  const span = Math.max(dayDiff(end, day), dayDiff(day, start), 0);
  for (let delta = 0; delta <= span; delta++) {
    const candidates = delta === 0 ? [day] : [addDaysToKey(day, delta), addDaysToKey(day, -delta)];
    for (const c of candidates) if (c >= start && c <= end && ok(c)) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanContentInput {
  dealer_id: string;
  period_start: string;
  days?: number;
  goal_id?: string | null;
}

export interface PlanContentOptions {
  /** delete the existing plans' still-PLANNED posts and re-plan them */
  replace?: boolean;
}

interface Occupant {
  post_id: string | null;
  account_id: string;
  date: string;
  model: string | null;
  pillar: ContentPillar;
  topic: string;
}

interface ConflictInfo {
  reason: 'duplicate_topic_in_period' | 'same_model_pillar_within_3_days';
  with: Occupant;
}

export interface ConflictResolution {
  account_id: string;
  nickname: string;
  slot_date: string;
  original: { model: string | null; pillar: ContentPillar; angle: string; topic: string };
  resolved: { model: string | null; pillar: ContentPillar; angle: string; topic: string; slot_date: string } | null;
  resolution: 'angle' | 'pillar' | 'model' | 'date' | 'dropped';
  reason: ConflictInfo['reason'];
  conflict_with: { account_id: string; post_id: string | null; date: string; topic: string };
}

interface AccountWork {
  account: XhsAccount;
  strategy: AccountStrategy;
  angleContext: AngleContext;
  existingPlan: ContentPlan | null;
  preserved: Post[];
  deleted: Post[];
  /** live posts of the account (this plan's progressed posts, other plans, unplanned) on days of this period */
  occupying: Post[];
  /** cadence of the period (posts per account) */
  target: number;
  slots: { date: string; pillar: ContentPillar; model: string | null }[];
  /** current days of this run's new slots (moved or dropped slots update it) */
  newDates: Set<string>;
  /** the day is free for the account and no overlapping plan period of the account would exceed its cadence */
  allowedDay: (day: string, chosen: readonly string[]) => boolean;
  pillarUsage: Map<ContentPillar, number>;
  stagger: number;
  planned: { date: string; pillar: ContentPillar; model: string | null; angle: string; topic: string }[];
}

function validateInput(input: PlanContentInput): { dealer_id: string; period_start: string; days: number; goal_id: string | null } {
  const parsed = v.object({
    dealer_id: v.string({ min: 1 }),
    period_start: v.string({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    days: v.optional(v.number({ int: true, min: 1, max: MAX_PLAN_DAYS })),
    goal_id: v.optional(v.nullable(v.string({ min: 1 }))),
  })(input, 'input');
  if (!isValidDateValue(parsed.period_start)) throw new ValidationError('input.period_start', 'not a calendar date');
  return { dealer_id: parsed.dealer_id, period_start: parsed.period_start, days: parsed.days ?? DEFAULT_PLAN_DAYS, goal_id: parsed.goal_id ?? null };
}

/** Each existing post in the period consumes the evenly spread date nearest to its own day. */
function removePreservedDates(dates: string[], preserved: readonly Post[], tz: string): string[] {
  const remaining = [...dates];
  const preservedDates = preserved.map((p) => postDay(p, tz)).sort();
  for (const d of preservedDates) {
    if (remaining.length === 0) break;
    let best = 0;
    for (let i = 1; i < remaining.length; i++) if (Math.abs(dayDiff(remaining[i], d)) < Math.abs(dayDiff(remaining[best], d))) best = i;
    remaining.splice(best, 1);
  }
  return remaining;
}

/** Non-rejected, non-failed posts of an account whose day (see `postDay`) lies in [from, to]. */
function livePostsOfAccount(ctx: AppContext, accountId: string, from: string, to: string, tz: string): Post[] {
  const fromIso = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const toIso = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  return ctx.db
    .table('posts')
    .query(
      `account_id = ? AND status NOT IN ('REJECTED', 'FAILED') AND ((slot_date >= ? AND slot_date <= ?) OR (published_at IS NOT NULL AND published_at >= ? AND published_at <= ?))`,
      [accountId, from, to, fromIso, toIso],
      { orderBy: 'slot_date ASC, id ASC' },
    )
    .filter((p) => {
      const day = postDay(p, tz);
      return day >= from && day <= to;
    });
}

function rotate<T>(list: readonly T[], start: number): T[] {
  if (list.length === 0) return [];
  const s = ((start % list.length) + list.length) % list.length;
  return [...list.slice(s), ...list.slice(0, s)];
}

/** Plan PLANNED post slots for every active, operable account of the dealer (idempotent per account + period_start). */
export function planContent(ctx: AppContext, rawInput: PlanContentInput, opts: PlanContentOptions = {}): { plans: ContentPlan[]; posts: Post[] } {
  const input = validateInput(rawInput);
  const dealer = getDealer(ctx, input.dealer_id);
  const tz = dealerTz(dealer);
  const goal = resolveGoal(ctx, dealer.id, { goal_id: input.goal_id });
  const periodStart = input.period_start;
  const periodEnd = addDaysToKey(periodStart, input.days - 1);
  const replace = opts.replace === true;
  const brandZh = getBrandInfo(dealer.brands[0] ?? '')?.brand_zh ?? dealer.brands[0] ?? '';

  return ctx.db.tx(() => {
    const accounts = ctx.db
      .table('xhs_accounts')
      .findMany({ dealer_id: dealer.id }, { orderBy: 'created_at ASC, nickname ASC' })
      .sort((a, b) => PLANNING_ORDER[a.account_type] - PLANNING_ORDER[b.account_type]);
    const excluded: { account_id: string; nickname: string; reason: string }[] = [];
    const included: XhsAccount[] = [];
    for (const account of accounts) {
      if (account.status !== 'active') {
        excluded.push({ account_id: account.id, nickname: account.nickname, reason: `账号状态为${account.status}，不排期` });
        continue;
      }
      const operable = isAccountOperable(ctx, account.id);
      if (operable.blocking) {
        excluded.push({ account_id: account.id, nickname: account.nickname, reason: operable.reason });
        continue;
      }
      included.push(account);
    }

    const postsTable = ctx.db.table('posts');
    const plansTable = ctx.db.table('content_plans');
    const typeIndex = new Map<AccountType, number>();
    const reused: ContentPlan[] = [];
    const work: AccountWork[] = [];

    for (const account of included) {
      const stagger = typeIndex.get(account.account_type) ?? 0;
      typeIndex.set(account.account_type, stagger + 1);
      const existingPlan =
        plansTable.queryOne(`account_id = ? AND period_start = ? AND status <> 'archived'`, [account.id, periodStart], { orderBy: 'created_at DESC' }) ?? null;
      if (existingPlan && !replace) {
        reused.push(existingPlan);
        continue;
      }
      const existingPosts = existingPlan ? postsTable.findMany({ plan_id: existingPlan.id }) : [];
      const preserved = existingPosts.filter((p) => p.status !== 'PLANNED');
      const deleted = existingPosts.filter((p) => p.status === 'PLANNED');
      const deletedIds = new Set(deleted.map((p) => p.id));
      const persona = ensurePersona(ctx, account);
      const strategy = buildAccountStrategy(ctx, account.id, { goal, goal_id: input.goal_id });
      const target = postsForPeriod(persona.goals?.monthly_posts, input.days);

      // Rolling plans overlap: every live post of the account on a day of this period counts toward its cadence and
      // blocks that day, and a new slot may never push an overlapping (other) plan period of the account over its cadence.
      const overlapping = plansTable
        .query(`account_id = ? AND status <> 'archived' AND period_start <= ? AND period_end >= ?`, [account.id, periodEnd, periodStart])
        .filter((p) => p.id !== existingPlan?.id)
        .map((p) => ({ start: p.period_start, end: p.period_end, cap: postsForPeriod(persona.goals?.monthly_posts, dayDiff(p.period_end, p.period_start) + 1) }));
      const rangeStart = overlapping.reduce((m, o) => (o.start < m ? o.start : m), periodStart);
      const rangeEnd = overlapping.reduce((m, o) => (o.end > m ? o.end : m), periodEnd);
      const accountDays = livePostsOfAccount(ctx, account.id, rangeStart, rangeEnd, tz)
        .filter((p) => !deletedIds.has(p.id))
        .map((p) => ({ post: p, day: postDay(p, tz) }));
      const occupying = accountDays.filter((x) => x.day >= periodStart && x.day <= periodEnd).map((x) => x.post);
      const days = accountDays.map((x) => x.day);
      const countIn = (list: readonly string[], start: string, end: string) => list.filter((d) => d >= start && d <= end).length;
      const allowedDay = (day: string, chosen: readonly string[]): boolean => {
        if (day < periodStart || day > periodEnd || days.includes(day) || chosen.includes(day)) return false;
        return overlapping.every((o) => day < o.start || day > o.end || countIn(days, o.start, o.end) + countIn(chosen, o.start, o.end) < o.cap);
      };
      const dates: string[] = [];
      for (const wanted of removePreservedDates(spreadSlotDates(periodStart, input.days, target), occupying, tz)) {
        const day = nearestAllowedDay(wanted, periodStart, periodEnd, (d) => allowedDay(d, dates));
        if (day) dates.push(day);
      }
      dates.sort();

      const weights = new Map(strategy.pillars.map((p) => [p.pillar, p.weight]));
      const sequence = pillarSequence(
        allocateRemainingPillars(
          strategy.pillars,
          target,
          occupying.map((p) => p.pillar),
          dates.length,
        ),
        weights,
      );
      // models: least-used focus model among the account's posts in the period (goal models first on ties)
      const focus = strategy.focus_models;
      const modelUse = new Map<string, number>(focus.map((m) => [m, 0]));
      for (const p of occupying) if (p.model !== null && modelUse.has(p.model)) modelUse.set(p.model, (modelUse.get(p.model) ?? 0) + 1);
      const slots = dates.map((date, k) => {
        let model: string | null = null;
        for (const m of focus) if (model === null || (modelUse.get(m) ?? 0) < (modelUse.get(model) ?? 0)) model = m;
        if (model !== null) modelUse.set(model, (modelUse.get(model) ?? 0) + 1);
        return { date, pillar: sequence[k], model };
      });
      const history = ctx.db.all<{ pillar: ContentPillar; n: number }>(
        `SELECT pillar, COUNT(*) AS n FROM posts WHERE account_id = ? AND slot_date < ? AND status NOT IN ('REJECTED', 'FAILED') GROUP BY pillar`,
        account.id,
        periodStart,
      );
      const pillarUsage = new Map(history.map((h) => [h.pillar, Number(h.n)]));
      for (const p of occupying) if (p.slot_date >= periodStart) pillarUsage.set(p.pillar, (pillarUsage.get(p.pillar) ?? 0) + 1);
      work.push({
        account,
        strategy,
        angleContext: { account_type: account.account_type, city: account.city || dealer.city, brand_zh: brandZh, taboo_topics: persona.taboo_topics ?? [] },
        existingPlan,
        preserved,
        deleted,
        occupying,
        target,
        slots,
        newDates: new Set(dates),
        allowedDay,
        pillarUsage,
        stagger,
        planned: [],
      });
    }

    // occupancy: existing dealer posts around the period (minus PLANNED posts being replaced)
    const deletedIds = new Set(work.flatMap((w) => w.deleted.map((p) => p.id)));
    const span = Math.max(CANNIBALIZATION_WINDOW_DAYS, input.days - 1);
    const lo = addDaysToKey(periodStart, -span);
    const hi = addDaysToKey(periodEnd, span);
    const loIso = new Date(Date.parse(`${lo}T00:00:00Z`) - DAY_MS).toISOString();
    const hiIso = new Date(Date.parse(`${hi}T00:00:00Z`) + 2 * DAY_MS).toISOString();
    const occupants: Occupant[] = postsTable
      .query(
        `dealer_id = ? AND status NOT IN ('REJECTED', 'FAILED') AND ((slot_date >= ? AND slot_date <= ?) OR (published_at IS NOT NULL AND published_at >= ? AND published_at <= ?))`,
        [dealer.id, lo, hi, loIso, hiIso],
      )
      .filter((p) => !deletedIds.has(p.id))
      .map((p) => ({
        post_id: p.id,
        account_id: p.account_id,
        date: postDay(p, tz),
        model: p.model,
        pillar: p.pillar,
        topic: p.topic,
      }))
      .filter((o) => o.date >= lo && o.date <= hi);

    const conflictOf = (accountId: string, date: string, model: string | null, pillar: ContentPillar, topic: string): ConflictInfo | null => {
      for (const o of occupants) {
        // never twice within one period length — a sliding window, so overlapping rolling plans hold the rule too
        if (o.topic === topic && Math.abs(dayDiff(o.date, date)) < input.days) return { reason: 'duplicate_topic_in_period', with: o };
      }
      for (const o of occupants) {
        if (o.account_id !== accountId && o.model === model && o.pillar === pillar && Math.abs(dayDiff(o.date, date)) <= CANNIBALIZATION_WINDOW_DAYS) {
          return { reason: 'same_model_pillar_within_3_days', with: o };
        }
      }
      return null;
    };

    const conflicts: ConflictResolution[] = [];
    const agenda = work
      .flatMap((w, wi) => w.slots.map((slot, si) => ({ w, wi, slot, si })))
      .sort((a, b) => a.slot.date.localeCompare(b.slot.date) || a.wi - b.wi || a.si - b.si);

    for (const { w, slot } of agenda) {
      const focus = w.strategy.focus_models;
      const angleStart = (p: ContentPillar) => (w.pillarUsage.get(p) ?? 0) + w.stagger;
      const originalAngles = anglesFor(w.angleContext, slot.pillar, slot.model);
      const originalAngle = rotate(originalAngles, angleStart(slot.pillar))[0] ?? '';
      const original = { model: slot.model, pillar: slot.pillar, angle: originalAngle, topic: topicKey(slot.model, slot.pillar, originalAngle) };

      const search = (date: string): { model: string | null; pillar: ContentPillar; angle: string; topic: string; level: 'none' | 'angle' | 'pillar' | 'model'; first: ConflictInfo | null } | null => {
        const models: (string | null)[] = focus.length > 0 ? rotate(focus, Math.max(0, focus.indexOf(slot.model ?? ''))) : [null];
        const pillars = [slot.pillar, ...w.strategy.pillars.map((p) => p.pillar).filter((p) => p !== slot.pillar)];
        let first: ConflictInfo | null = null;
        for (let mi = 0; mi < models.length; mi++) {
          for (let pi = 0; pi < pillars.length; pi++) {
            const angles = rotate(anglesFor(w.angleContext, pillars[pi], models[mi]), angleStart(pillars[pi]));
            for (let ai = 0; ai < angles.length; ai++) {
              const topic = topicKey(models[mi], pillars[pi], angles[ai]);
              const c = conflictOf(w.account.id, date, models[mi], pillars[pi], topic);
              if (!c) {
                const level = mi > 0 ? 'model' : pi > 0 ? 'pillar' : ai > 0 ? 'angle' : 'none';
                return { model: models[mi], pillar: pillars[pi], angle: angles[ai], topic, level, first };
              }
              first ??= c;
            }
          }
        }
        return first ? { model: null, pillar: slot.pillar, angle: '', topic: '', level: 'none', first } : null;
      };

      let date = slot.date;
      let found = search(date);
      let resolution: ConflictResolution['resolution'] | null = null;
      let firstConflict: ConflictInfo | null = found?.first ?? null;
      if (found && found.topic === '') {
        // every model × pillar × angle conflicts on this date: try the account's other free dates in the period
        found = null;
        const candidates: string[] = [];
        const otherNewDates = [...w.newDates].filter((d) => d !== slot.date);
        for (let d = 0; d < input.days; d++) {
          const key = addDaysToKey(periodStart, d);
          if (key !== slot.date && w.allowedDay(key, otherNewDates)) candidates.push(key);
        }
        candidates.sort((a, b) => Math.abs(dayDiff(a, slot.date)) - Math.abs(dayDiff(b, slot.date)) || a.localeCompare(b));
        for (const alt of candidates) {
          const r = search(alt);
          if (r && r.topic !== '') {
            found = r;
            date = alt;
            resolution = 'date';
            break;
          }
        }
        if (!found) {
          resolution = 'dropped';
          w.newDates.delete(slot.date);
        }
      } else if (found && found.level !== 'none') {
        resolution = found.level;
      }

      if (found && found.topic !== '') {
        if (date !== slot.date) {
          w.newDates.delete(slot.date);
          w.newDates.add(date);
        }
        occupants.push({ post_id: null, account_id: w.account.id, date, model: found.model, pillar: found.pillar, topic: found.topic });
        w.pillarUsage.set(found.pillar, (w.pillarUsage.get(found.pillar) ?? 0) + 1);
        w.planned.push({ date, pillar: found.pillar, model: found.model, angle: found.angle, topic: found.topic });
      }
      if (resolution && firstConflict) {
        conflicts.push({
          account_id: w.account.id,
          nickname: w.account.nickname,
          slot_date: slot.date,
          original,
          resolved: found && found.topic !== '' ? { model: found.model, pillar: found.pillar, angle: found.angle, topic: found.topic, slot_date: date } : null,
          resolution,
          reason: firstConflict.reason,
          conflict_with: { account_id: firstConflict.with.account_id, post_id: firstConflict.with.post_id, date: firstConflict.with.date, topic: firstConflict.with.topic },
        });
      }
    }

    // persist
    const now = ctx.clock.iso();
    const createdPlans: {
      plan: ContentPlan;
      replanned: boolean;
      post_ids: string[];
      deleted: string[];
      preserved: string[];
      existing_in_period: string[];
      target: number;
    }[] = [];
    for (const w of work) {
      for (const p of w.deleted) postsTable.delete(p.id);
      let plan: ContentPlan;
      if (w.existingPlan) {
        plan = plansTable.update(w.existingPlan.id, { strategy: w.strategy, period_end: periodEnd, status: 'active', workflow_run_id: ctx.runId ?? w.existingPlan.workflow_run_id });
      } else {
        plan = plansTable.insert({
          id: newId('plan'),
          dealer_id: dealer.id,
          account_id: w.account.id,
          period_start: periodStart,
          period_end: periodEnd,
          strategy: w.strategy,
          status: 'active',
          workflow_run_id: ctx.runId,
          created_at: now,
          updated_at: now,
        });
      }
      const policy = effectivePublishPolicy(ctx, w.account.id).policy;
      const postIds: string[] = [];
      for (const slot of [...w.planned].sort((a, b) => a.date.localeCompare(b.date))) {
        const post = postsTable.insert({
          id: newId('post'),
          dealer_id: dealer.id,
          account_id: w.account.id,
          plan_id: plan.id,
          slot_date: slot.date,
          pillar: slot.pillar,
          topic: slot.topic,
          angle: slot.angle,
          model: slot.model,
          title: '',
          body: '',
          tags: [],
          cover_text: '',
          fact_refs: [],
          status: 'PLANNED',
          review: null,
          approval_policy: policy,
          platform_note_id: null,
          scheduled_for: null,
          published_at: null,
          metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
          metrics_updated_at: null,
          engine: 'rules',
          created_at: now,
          updated_at: now,
        });
        postIds.push(post.id);
      }
      const existingInPeriod = w.occupying.map((p) => p.id);
      createdPlans.push({
        plan,
        replanned: !!w.existingPlan,
        post_ids: postIds,
        deleted: w.deleted.map((p) => p.id),
        preserved: w.preserved.map((p) => p.id),
        existing_in_period: existingInPeriod,
        target: w.target,
      });
      ctx.audit.event({
        actor: `agent:${PLANNING_AGENT}`,
        action: w.existingPlan ? 'content_plan.replanned' : 'content_plan.created',
        entity_type: 'content_plan',
        entity_id: plan.id,
        details: {
          dealer_id: dealer.id,
          account_id: w.account.id,
          period_start: periodStart,
          period_end: periodEnd,
          post_ids: postIds,
          deleted_post_ids: w.deleted.map((p) => p.id),
          preserved_post_ids: w.preserved.map((p) => p.id),
          existing_in_period_post_ids: existingInPeriod,
          cadence: { target: w.target, existing_in_period: existingInPeriod.length, planned: postIds.length },
        },
      });
    }

    if (createdPlans.length > 0) {
      const dropped = conflicts.filter((c) => c.resolution === 'dropped').length;
      const evidence: Evidence[] = createdPlans.map((c) => ({
        code: c.replanned ? 'content_plan_replanned' : 'content_plan_created',
        label: `${included.find((a) => a.id === c.plan.account_id)?.nickname ?? c.plan.account_id}：${c.post_ids.length}篇`,
        source_ref: `content_plan:${c.plan.id}`,
      }));
      ctx.audit.decision({
        agent: PLANNING_AGENT,
        skill: SKILL_NAME,
        decision_type: 'content_plan',
        subject_type: 'dealer',
        subject_id: dealer.id,
        inputs: {
          dealer_id: dealer.id,
          period_start: periodStart,
          period_end: periodEnd,
          days: input.days,
          goal_id: input.goal_id,
          replace,
          cannibalization_window_days: CANNIBALIZATION_WINDOW_DAYS,
        },
        evidence,
        output: {
          plans: createdPlans.map((c) => ({
            plan_id: c.plan.id,
            account_id: c.plan.account_id,
            replanned: c.replanned,
            posts: c.post_ids.length,
            post_ids: c.post_ids,
            deleted_post_ids: c.deleted,
            preserved_post_ids: c.preserved,
            existing_in_period_post_ids: c.existing_in_period,
            cadence: { target: c.target, existing_in_period: c.existing_in_period.length, planned: c.post_ids.length },
            pillars: c.plan.strategy.pillars.map((p) => ({ pillar: p.pillar, weight: p.weight })),
          })),
          reused_plans: reused.map((p) => ({ plan_id: p.id, account_id: p.account_id })),
          excluded_accounts: excluded,
          conflicts_resolved: conflicts,
        },
        confidence: dropped > 0 ? 0.7 : 0.85,
        engine: 'rules',
        workflow_run_id: ctx.runId,
      });
    }

    const planOrder = new Map(included.map((a, i) => [a.id, i]));
    const plans = [...reused, ...createdPlans.map((c) => c.plan)].sort((a, b) => (planOrder.get(a.account_id) ?? 0) - (planOrder.get(b.account_id) ?? 0));
    const posts = plans
      .flatMap((p) => postsTable.findMany({ plan_id: p.id }))
      .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || (planOrder.get(a.account_id) ?? 0) - (planOrder.get(b.account_id) ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return { plans, posts };
  });
}

export interface ContentPlanningSkillInput extends PlanContentInput {
  replace?: boolean;
}

export const skill = defineSkill<ContentPlanningSkillInput, { plans: ContentPlan[]; posts: Post[] }>({
  name: SKILL_NAME,
  category: 'content',
  agent: 'account-strategy-agent',
  description:
    '内容排期：为门店每个可运营账号生成账号策略并按权重分配内容支柱、车型与人设专属角度，跨账号去重（同车型同支柱3天内不重复、同一选题周期内不重复），生成待创作的PLANNED笔记；同一账号同一周期幂等，可选择重排。',
  input: v.object({
    dealer_id: v.string({ min: 1 }),
    period_start: v.string({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    days: v.optional(v.number({ int: true, min: 1, max: MAX_PLAN_DAYS })),
    goal_id: v.optional(v.nullable(v.string({ min: 1 }))),
    replace: v.optional(v.boolean()),
  }),
  run(ctx, input) {
    return planContent(ctx, { dealer_id: input.dealer_id, period_start: input.period_start, days: input.days, goal_id: input.goal_id ?? null }, { replace: input.replace });
  },
  validateOutput(output) {
    const planIds = new Set(output.plans.map((p) => p.id));
    for (const post of output.posts) {
      if (!post.plan_id || !planIds.has(post.plan_id)) throw new Error(`content-planning: post ${post.id} does not belong to a returned plan`);
    }
    for (const plan of output.plans) {
      if (plan.period_end < plan.period_start) throw new Error(`content-planning: plan ${plan.id} ends before it starts`);
    }
  },
});
