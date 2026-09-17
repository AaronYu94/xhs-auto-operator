/**
 * Business-goal parser (spec §3): turns an operator's sentence ("这个月在杭州获取宝马i3线索",
 * "Generate BMW i3 leads in Hangzhou this month", "下周重点推X3，每个账号发3篇") into a structured GoalSpec.
 *
 * Deterministic and evidence-bound: brands/models/locations come from the automotive lexicon (plus the dealer's own
 * catalog), timeframes are resolved in the dealer's timezone, and anything not stated is left unset (the planner and
 * query generator fall back to Dealer Brain rows, never to invented values). Every interpretation is explained in
 * `spec.notes` so the operator can see how the sentence was understood.
 */
import { ValidationError } from '../core/errors.ts';
import { DAY_MS, DEFAULT_TZ, addDaysToKey, localDateKey, localParts, zonedTimeToUtc } from '../core/time.ts';
import type { Dealer, GoalSpec, GoalType } from '../core/types.ts';
import { findBrands, findLocation, findModels, getBrandInfo, getModelInfo, parseChineseNumber, type ExtraModel } from '../domain/automotive-lexicon.ts';

export const MAX_GOAL_TEXT = 500;

/** Optional dealer catalog so models missing from the lexicon still resolve and uncarried models are flagged. */
export interface GoalCatalog {
  models: { brand: string; model: string; aliases?: readonly string[] }[];
}

const LEAD_RE = /线索|获客|拓客|客户|意向|留资|潜客|买家|到店|预约|成交|卖(?:出|掉)?\d*台|订单|\bleads?\b|prospects?|buyers?|customers?|appointments?|sales\b/i;
const CONTENT_RE = /发(?:布)?\s*[\d一二三四五六七八九十两]*\s*篇|篇笔记|笔记|内容|种草|发帖|发文|推广|曝光|涨粉|\bcontent\b|\bposts?\b|\bnotes?\b|publish/i;
const REPORT_RE = /报告|日报|周报|月报|复盘|总结|汇报|\breport\b|\bsummary\b/i;
const DAILY_RE = /日常|每天|每日|例行|自动运营|daily|routine/i;

const CN_NUM = '[\\d一二三四五六七八九十百两]+';
/** '30条线索' / '目标30条' — the number must not be part of a model name ('i3线索', 'X3客户'). */
const TARGET_LEADS_RE = new RegExp(
  `目标\\s*(?:是|为)?\\s*(${CN_NUM})\\s*(?:个|条|位|名)|(?<![A-Za-z\\d.])(${CN_NUM})\\s*(?:个|条|位|名|组)?\\s*(?:高意向|合格|有效|意向|精准)?\\s*(?:线索|客户|留资|潜客)`,
);
const TARGET_LEADS_EN_RE = /(\d+)\s+(?:(?:qualified|high[- ]intent|new)\s+)?leads?\b/i;
const POSTS_PER_ACCOUNT_RE = new RegExp(`每(?:个|一个)?(?:账号|号)\\s*(?:每周|每天)?\\s*发(?:布)?\\s*(${CN_NUM})\\s*篇`);
const APPOINTMENTS_RE = new RegExp(`(${CN_NUM})\\s*(?:个|组|位|批)?\\s*(?:到店)?预约|预约\\s*(${CN_NUM})\\s*(?:个|组|位)`);
const LAST_N_DAYS_RE = new RegExp(`(?:未来|接下来|最近|近)\\s*(${CN_NUM})\\s*(天|周|个?月)|(${CN_NUM})\\s*(天|周|个月)内`);
const EN_N_DAYS_RE = /(?:next|within|in the next)\s+(\d+)\s+(days?|weeks?|months?)/i;
const MONTH_RE = new RegExp(`(?<![\\d个上下这本每])(1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])月(?:份)?(?![\\d号日供租薪])`);

const EN_CITIES: Record<string, string> = {
  hangzhou: '杭州',
  shanghai: '上海',
  beijing: '北京',
  shenzhen: '深圳',
  guangzhou: '广州',
  ningbo: '宁波',
  suzhou: '苏州',
  nanjing: '南京',
  chengdu: '成都',
  wuhan: '武汉',
  hefei: '合肥',
  wenzhou: '温州',
  shaoxing: '绍兴',
  jiaxing: '嘉兴',
  wuxi: '无锡',
  tianjin: '天津',
  chongqing: '重庆',
  xian: '西安',
  "xi'an": '西安',
  zhejiang: '浙江',
  jiangsu: '江苏',
  guangdong: '广东',
};

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseChineseNumber(raw);
  return n !== null && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function dealerTz(dealer: Pick<Dealer, 'settings'>): string {
  return dealer.settings?.timezone || DEFAULT_TZ;
}

function detectType(text: string): { type: GoalType; why: string } {
  const lead = LEAD_RE.exec(text);
  if (lead) return { type: 'lead_generation', why: `识别为获客目标（“${lead[0]}”）` };
  const content = CONTENT_RE.exec(text);
  if (content) return { type: 'content_campaign', why: `识别为内容运营目标（“${content[0]}”）` };
  const report = REPORT_RE.exec(text);
  if (report) return { type: 'reporting', why: `识别为经营报告（“${report[0]}”）` };
  const daily = DAILY_RE.exec(text);
  if (daily) return { type: 'daily_operations', why: `识别为日常运营（“${daily[0]}”）` };
  return { type: 'daily_operations', why: '未识别到明确的获客/内容/报告意图，按日常运营处理' };
}

interface Timeframe {
  label: string;
  start: string;
  end: string;
}

/** Local midnight (as UTC instant) of a 'YYYY-MM-DD' key in tz. */
function midnight(key: string, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0, tz);
}

function monthStartKey(year: number, month: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function range(label: string, startKey: string, endKey: string, tz: string, clampStart?: Date): Timeframe {
  const start = midnight(startKey, tz);
  const s = clampStart && clampStart.getTime() > start.getTime() ? clampStart : start;
  return { label, start: s.toISOString(), end: midnight(endKey, tz).toISOString() };
}

/** Resolve the goal's timeframe in the dealer's timezone. End is exclusive. Returns null when none is stated. */
export function resolveGoalTimeframe(text: string, now: Date, tz: string = DEFAULT_TZ): Timeframe | null {
  const p = localParts(now, tz);
  const today = localDateKey(now, tz);
  const mondayOffset = (p.weekday + 6) % 7; // days since Monday
  const thisMonday = addDaysToKey(today, -mondayOffset);
  const lower = text.toLowerCase();

  if (/今天|今日|\btoday\b/.test(lower)) return range(`今天（${today}）`, today, addDaysToKey(today, 1), tz);
  if (/明天|明日|\btomorrow\b/.test(lower)) {
    const t = addDaysToKey(today, 1);
    return range(`明天（${t}）`, t, addDaysToKey(t, 1), tz);
  }
  if (/下(?:个)?(?:周|星期|礼拜)|\bnext week\b/.test(lower)) {
    const start = addDaysToKey(thisMonday, 7);
    return range(`下周（${start} 起）`, start, addDaysToKey(start, 7), tz);
  }
  if (/(?:这|本)(?:个)?(?:周|星期|礼拜)|\bthis week\b/.test(lower)) {
    return range(`本周（${thisMonday} 起）`, thisMonday, addDaysToKey(thisMonday, 7), tz, now);
  }
  if (/下(?:个)?月|\bnext month\b/.test(lower)) {
    const start = monthStartKey(p.year, p.month + 1);
    const m = Number(start.slice(5, 7));
    return range(`下个月（${m}月）`, start, monthStartKey(p.year, p.month + 2), tz);
  }
  if (/(?:这|本)(?:个)?月|月底前|\bthis month\b/.test(lower)) {
    return range(`本月（${p.month}月）`, monthStartKey(p.year, p.month), monthStartKey(p.year, p.month + 1), tz, now);
  }
  if (/(?:这|本)(?:个)?季度|\bthis quarter\b/.test(lower)) {
    const qStart = Math.floor((p.month - 1) / 3) * 3 + 1;
    return range(`本季度（${qStart}–${qStart + 2}月）`, monthStartKey(p.year, qStart), monthStartKey(p.year, qStart + 3), tz, now);
  }
  const nDays = LAST_N_DAYS_RE.exec(text);
  const enDays = EN_N_DAYS_RE.exec(text);
  if (nDays || enDays) {
    const count = nDays ? toNumber(nDays[1] ?? nDays[3]) : toNumber(enDays?.[1]);
    const unitRaw = nDays ? (nDays[2] ?? nDays[4]) : enDays?.[2] ?? '';
    if (count) {
      const days = /周|week/i.test(unitRaw) ? count * 7 : /月|month/i.test(unitRaw) ? count * 30 : count;
      const end = new Date(now.getTime() + days * DAY_MS);
      return { label: `未来${days}天`, start: now.toISOString(), end: end.toISOString() };
    }
  }
  const month = MONTH_RE.exec(text);
  if (month) {
    const m = toNumber(month[1]);
    if (m && m >= 1 && m <= 12) {
      const year = m < p.month ? p.year + 1 : p.year;
      return range(`${m}月`, monthStartKey(year, m), monthStartKey(year, m + 1), tz, m === p.month ? now : undefined);
    }
  }
  return null;
}

function resolveLocation(text: string): { city?: string; province?: string; quote: string } | null {
  const direct = findLocation(text);
  if (direct) return direct;
  const lower = text.toLowerCase();
  for (const [en, zh] of Object.entries(EN_CITIES)) {
    if (new RegExp(`\\b${en.replace("'", "'?")}\\b`, 'i').test(lower)) {
      const found = findLocation(zh);
      if (found) return { ...found, quote: en };
    }
  }
  return null;
}

/**
 * Parse an operator goal. `now` is the reference instant (ctx.clock.now()); timeframes use the dealer timezone.
 * Throws ValidationError for empty or over-long text.
 */
export function parseGoal(text: string, dealer: Dealer, now: Date, catalog?: GoalCatalog): GoalSpec {
  const raw = typeof text === 'string' ? text.normalize('NFKC').trim() : '';
  if (!raw) throw new ValidationError('text', '经营目标不能为空');
  if ([...raw].length > MAX_GOAL_TEXT) throw new ValidationError('text', `经营目标最多 ${MAX_GOAL_TEXT} 个字符`);

  const tz = dealerTz(dealer);
  const notes: string[] = [];
  const { type, why } = detectType(raw);
  notes.push(why);

  // ── vehicles ────────────────────────────────────────────────────────────────
  const extra: ExtraModel[] = (catalog?.models ?? []).filter((m) => !getModelInfo(m.model)).map((m) => ({ brand: m.brand, model: m.model, aliases: m.aliases }));
  const stated = findModels(raw, { extra });
  const carriedKeys = catalog ? new Set(catalog.models.map((m) => m.model.toLowerCase())) : null;
  const models: string[] = [];
  for (const m of stated) {
    if (carriedKeys && !carriedKeys.has(m.model.toLowerCase())) {
      notes.push(`车型「${m.quote}」不在本店车型库，未纳入目标`);
      continue;
    }
    if (!models.includes(m.model)) models.push(m.model);
  }

  const dealerBrands = dealer.brands.map((b) => getBrandInfo(b)?.brand ?? b);
  let brand: string | undefined;
  const statedBrands = findBrands(raw);
  const carriedBrand = statedBrands.find((b) => dealerBrands.includes(b.brand));
  if (carriedBrand) brand = carriedBrand.brand;
  else if (statedBrands.length > 0) notes.push(`品牌「${statedBrands[0].quote}」不是本店经营品牌，已忽略`);
  if (!brand && models.length > 0) {
    const modelBrand = stated.find((m) => models.includes(m.model))?.brand;
    if (modelBrand) brand = getBrandInfo(modelBrand)?.brand ?? modelBrand;
  }
  if (models.length > 0) notes.push(`目标车型：${models.join('、')}`);
  else if (type === 'lead_generation' || type === 'content_campaign') notes.push('未指定车型：按门店库存与在售车型自动选择');

  // ── location ────────────────────────────────────────────────────────────────
  const spec: GoalSpec = { type, models };
  if (brand) spec.brand = brand;
  const loc = resolveLocation(raw);
  if (loc) {
    if (loc.city) spec.location = loc.city;
    if (loc.province) spec.province = loc.province;
    notes.push(`目标地域：${loc.city ?? loc.province}${loc.city && loc.province && loc.province !== loc.city ? `（${loc.province}）` : ''}`);
    if (loc.province && dealer.province && loc.province !== dealer.province) {
      notes.push(`注意：目标地域不在门店所在省份（${dealer.province}），异地线索评分会被限制`);
    }
  } else if (/本地|同城|附近|local/i.test(raw) && dealer.city) {
    spec.location = dealer.city;
    spec.province = dealer.province;
    notes.push(`目标地域：门店所在城市（${dealer.city}）`);
  } else if (type === 'lead_generation') {
    notes.push(`未指定地域：默认门店所在地（${dealer.city}）`);
  }

  // ── timeframe ───────────────────────────────────────────────────────────────
  const timeframe = resolveGoalTimeframe(raw, now, tz);
  if (timeframe) {
    spec.timeframe = timeframe;
    notes.push(`时间范围：${timeframe.label}`);
  } else {
    notes.push('未指定时间范围：按持续执行处理');
  }

  // ── numeric targets ─────────────────────────────────────────────────────────
  const leads = TARGET_LEADS_RE.exec(raw) ?? TARGET_LEADS_EN_RE.exec(raw);
  const leadCount = toNumber(leads?.[1] ?? leads?.[2]);
  if (leadCount) {
    spec.target_leads = leadCount;
    notes.push(`线索目标：${leadCount} 条`);
  }
  const posts = POSTS_PER_ACCOUNT_RE.exec(raw);
  const postCount = toNumber(posts?.[1]);
  if (postCount) notes.push(`每个账号发布 ${postCount} 篇`);
  const appts = APPOINTMENTS_RE.exec(raw);
  const apptCount = toNumber(appts?.[1] ?? appts?.[2]);
  if (apptCount) notes.push(`到店预约目标：${apptCount} 个`);

  spec.notes = notes;
  return spec;
}

/** Structured numbers the planner reads back from the parsed notes. */
export function goalTargets(spec: GoalSpec): { posts_per_account: number | null; appointments: number | null } {
  const notes = spec.notes ?? [];
  const posts = notes.map((n) => /^每个账号发布 (\d+) 篇$/.exec(n)).find(Boolean);
  const appts = notes.map((n) => /^到店预约目标：(\d+) 个$/.exec(n)).find(Boolean);
  return { posts_per_account: posts ? Number(posts[1]) : null, appointments: appts ? Number(appts[1]) : null };
}
