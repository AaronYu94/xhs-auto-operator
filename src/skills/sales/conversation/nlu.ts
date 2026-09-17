/**
 * Deterministic conversation NLU for direct-message replies (pure, no I/O).
 *
 * detectConversationIntents  intents (subset of CONVERSATION_INTENTS) with verbatim evidence quotes
 * extractSlots               incremental slot filling merged with previous conversation slots
 * resolveAppointmentTime     Chinese relative/absolute date + time expressions → UTC ISO (weeks start Monday)
 * detectContactInfo          voluntarily provided phone / WeChat
 */
import { dedupeEvidence } from '../../../core/evidence.ts';
import { DAY_MS, localParts, zonedTimeToUtc } from '../../../core/time.ts';
import { CONVERSATION_INTENTS, type ConversationIntent, type ConversationSlots, type Evidence } from '../../../core/types.ts';
import {
  clauseAt,
  detectTimeframeMapped,
  findBrands,
  findFirst,
  findLocationsMapped,
  findMatches,
  findModels,
  findTrims,
  groupQuote,
  isNegatedAt,
  isStandaloneRefusal,
  mapText,
  parseBudgetMapped,
  parseChineseNumber,
  rawSlice,
  type MappedText,
  type TextHit,
} from '../../../domain/automotive-lexicon.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Contact info
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_RE = /(?<!\d)(?:\+?86[ -]?)?(1[ -]?[3-9](?:[ -]?\d){9})(?!\d)/;
const WECHAT_PREFIX = '(?:微信号?|(?<![a-z0-9])(?:vx|wx|weixin|wechat)|v信|薇信|威信)';
const WXID_RE = /(?<![a-z0-9])(wxid_[-_a-z0-9]{4,24})(?![-_a-z0-9])/;
const WECHAT_CONNECTOR = '(?:号)?(?:是|为|:|就是|搜索|搜|加| )*';
const WECHAT_ID_RE = new RegExp(`${WECHAT_PREFIX}${WECHAT_CONNECTOR}([a-z][-_a-z0-9]{5,19})(?![-_a-z0-9])`);
const WECHAT_PHONE_RE = new RegExp(`${WECHAT_PREFIX}${WECHAT_CONNECTOR}(1[3-9]\\d{9})(?!\\d)`);
const WECHAT_SAME_AS_PHONE_RE = /(?:微信|vx|wx|v信)(?:号)?(?:同号|同手机号?|就是手机号?|和手机号?一样|同电话)/;

function phoneHit(mt: MappedText): { phone: string; hit: TextHit } | null {
  for (const h of findMatches(mt, PHONE_RE)) {
    const digits = (h.groups[1] ?? '').replace(/\D/g, '');
    if (/^1[3-9]\d{9}$/.test(digits)) return { phone: digits, hit: h };
  }
  return null;
}

function wechatHit(mt: MappedText, phone: string | undefined): { wechat: string; hit: TextHit } | null {
  const wxid = findFirst(mt, WXID_RE);
  if (wxid) return { wechat: groupQuote(mt, wxid, 1), hit: wxid };
  const id = findFirst(mt, WECHAT_ID_RE);
  if (id) return { wechat: groupQuote(mt, id, 1), hit: id };
  const byPhone = findFirst(mt, WECHAT_PHONE_RE);
  if (byPhone) return { wechat: (byPhone.groups[1] ?? '').replace(/\D/g, ''), hit: byPhone };
  const same = findFirst(mt, WECHAT_SAME_AS_PHONE_RE);
  if (same && phone) return { wechat: phone, hit: same };
  return null;
}

/** Voluntarily provided phone (mainland mobile, spaces/dashes tolerated) and WeChat id. */
export function detectContactInfo(text: string): { phone?: string; wechat?: string } {
  const mt = mapText(text);
  const phone = phoneHit(mt)?.phone;
  const wechat = wechatHit(mt, phone)?.wechat;
  return { ...(phone ? { phone } : {}), ...(wechat ? { wechat } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intents
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_RE =
  /多少钱|什么价|啥价|价格|报价|价位|价钱|售价|裸车|落地(?!窗|灯)|优惠|折扣|打折|便宜|让利|降价|底价|最低价|团购|有什么政策|啥政策|几个w|多少w|指导价|(?<![优惠落地便宜降让补贴首付月供利率等航耗间里度了力矩寸距池保养钱速量压重宽长径温噪积容])多少(?!钱|公里|km|度|个|天|年|久|岁|人|次|级|分|秒|期|%|台|辆|现车|库存|颜色|种|款|配置|优惠|折扣|油|电|续航|空间|马力|首付|月供|定金|订金|利息)/;
const INVENTORY_RE =
  /有现车|现车|现货|有车吗|有没有车|库存|提车|要等多久|等多久|多久能提|多久提|几天能提|能提车|有货|车源|排产|交付|到港|在途|还有吗|还在吗|还有没有/;
const COMPARE_KW_RE = /还是|vs|对比|纠结|选哪个|选哪台|哪个好|哪个更|怎么选|二选一|pk|比较|选谁|买哪个|相比|比起|区别/;
const FINANCE_RE = /贷款|车贷|分期|首付|月供|利率|0息|零息|免息|低息|贴息|金融|按揭|全款|一次性付清/;
const FINANCE_TERMS_RE = /贷款|车贷|分期|首付|月供|利率|0息|零息|免息|低息|贴息|金融方案|金融|按揭/;
const FULL_PAYMENT_RE = /全款|一次性付清|付全款/;
const LEASE_RE = /融资租赁|以租代购|租赁|租购|长租/;
const TRADE_IN_RE = /以旧换新|置换|旧车|换购|老车(?!主)|估个价|二手车评估|旧车估价/;
const NO_TRADE_IN_RE = /没有旧车|没旧车|首购|第一辆车|第一台车|首次购车|第一次买车/;
/** '过去/过来' only as a movement to the showroom ('我明天过去', '下午过来看'), never '过去三年' / '都过去了'. */
const COME_GO_TAIL = '(?=看|试|店|提|一趟|聊|找|拿|签|吧|啊|哈|呀|哦|~|$|[,。!?\\s])';
const VISIT_RE = new RegExp(
  `到店(?!价)|来店|去店里|去你们店|去你们那|到你们店|过去看|过来看|看车|看看车|试驾|约个时间|约时间|预约|登门|见面|去4s|去看看|来看看|上门|过去${COME_GO_TAIL}|过来${COME_GO_TAIL}|(?:去|来)看(?:一下|一眼)?(?=[^,。!?]{0,3}?(?:车|[a-z0-9]|宝马|实物))`,
);
const VISIT_CANCEL_RE = /不去了|去不了|来不了|不过去了|没空去|没时间去|取消预约|取消|改天再说|不来了|去不成/;
/** Availability words; '行' only standalone ('周六行吗'), never inside 银行/行驶. Negated forms are filtered in code. */
const AVAILABILITY_RE =
  /行不行|有没有空|有没有时间|有空|方便|有时间|没问题|可以|ok|好的|(?<=^|[,。!?\s天日末六五四三二一上下午晚早点号])行(?=$|[,。!?\s吧啊的吗呀哈])/;
/** A clause refusing a time slot ('明天不行', '周六没空'); A-不-A questions ('行不行', '能不能去') are not refusals. */
const REFUSED_SLOT_RE =
  /(?<!行)不行|(?<!便)不方便|不太方便|(?<!有)没空|(?<!有)没有空|(?<!有)没时间|(?<!有)没有时间|去不了|来不了|(?<!去)不去|(?<!来)不来|(?<!可)不可以|(?<!能)不能|改天|(?<!店|面|时候|来|去)再说|没办法|不一定/;
/** Clock time used as a meeting point ('下午3点见', '10点过来'). */
const MEETING_SUFFIX_RE = /^(?:钟|左右)?(?:见|过来|过去|到)/;
const CONTACT_CUE_RE =
  /我电话|我的电话|电话是|手机号|手机是|我手机|加我|留个电话|留电话|留个联系方式|我微信|微信号|加微信|加个微信|联系方式|打我电话|给我打电话|号码是|电话号码|打给我/;
const CONTACT_REFUSAL_BEFORE_RE = /(?:不方便|不想|不给|不留|不加|不用|不要|别|不能)[^,。!?]{0,5}$/;
/**
 * Explicit do-not-contact phrasing (spec §24 — must never be missed). '别' is not the second character of a word
 * ('区别发…'); '发' is not the start of an unrelated verb ('别发愁').
 */
const HARD_NEGATIVE_RE =
  /(?<![区差识分级类性告特派辨鉴个])别再?(?:给我|跟我)?(?:发(?!愁|呆|火|现|动|展|挥|布|表|票|货|型|音|生|烧|光|芽|酵|育)|私信|推送|打电话|联系|打扰|骚扰|烦我)|(?:不要|请勿|勿|不用)(?:再(?:给我|跟我)?(?:发|私信|推送|打电话|联系|打扰|骚扰)|(?:给我|跟我)?(?:发(?:了|消息|信息|私信)|私信我|推送|打电话|联系我|打扰|骚扰))|拉黑|举报|骚扰|打扰到我|退订/;
const DISINTEREST_RE = /不感兴趣|没兴趣|没有兴趣/;
/** Bought elsewhere / already bought — but not when asked as a question ('买好了吗'). */
const PURCHASED_RE =
  /(?:已经买了|已经提了|已经提车|已经订了|已经下定|已经买好|买好了|已经入手|买了别的|订了别的|提了别的|(?:别处|别的店|其他店|其它店|其他地方|别的地方|别家)(?:订|买|提|下定)了?)(?![吗么嘛没?]|了吗|了么|了没)/;
const SOFT_NEGATIVE_RE = /不需要|不用了|暂不考虑|先不考虑|不考虑了?|不买了|不想买了|不打算买了?|没打算买|不要了|先不用/;
const TRADE_IN_VEHICLE_RE = /(?:旧车|老车|现在的车|现在开的|目前开的|手上的车|手里的车|置换的车|要置换的|我的车)(?:是|为|:|就是)? *([^,。!?\n;]{2,30})/;
const TRADE_IN_VEHICLE_CUT_RE = /想|要|能|可以|打算|准备|置换|怎么|多少|吗|估|值|卖|有|补贴/;
const VEHICLE_DESCRIPTOR_RE =
  /\d{2,4} *年|[一二三四五六七八九十两]+年|大众|丰田|本田|日产|别克|雪佛兰|福特|马自达|现代|起亚|吉利|长城|哈弗|长安|奇瑞|荣威|名爵|领克|红旗|凯迪拉克|英菲尼迪|路虎|捷豹|保时捷|五菱|传祺|小鹏|问界|极氪|零跑|斯柯达|标致|雪铁龙|jeep|mini|公里|万公里/;

const INTENT_LABELS: Record<ConversationIntent, string> = {
  price_query: '询问价格/优惠',
  inventory_query: '询问现车/提车',
  model_comparison: '车型对比',
  finance_query: '金融/付款方式',
  lease_query: '询问租赁',
  trade_in: '置换需求',
  appointment: '到店/看车意向',
  contact_exchange: '提供/交换联系方式',
  not_interested: '明确拒绝/不感兴趣',
  general: '一般回复',
};

interface ModelSpan {
  brand: string;
  model: string;
  quote: string;
  start: number;
  end: number;
}

/** Comparison cue: 2+ models with a comparison keyword, or '和/跟/与 <model> 比…', '比<model>好', 'vs <model>'. */
function comparisonHit(mt: MappedText, models: ModelSpan[]): TextHit | null {
  if (models.length >= 2) {
    const kw = findFirst(mt, COMPARE_KW_RE);
    if (kw) return kw;
  }
  for (const m of models) {
    const before = mt.norm.slice(Math.max(0, m.start - 4), m.start);
    const after = mt.norm.slice(m.end, m.end + 8);
    const conj = /(?:和|跟|与|比起|相比|对比|vs|pk) *$/.exec(before);
    const cmpAfter = /比|区别|差别|哪个|怎么样|好在|强在|差在|如何/.exec(after);
    if (conj && cmpAfter) {
      const start = m.start - (before.length - conj.index);
      return spanHit(mt, start, m.end + cmpAfter.index + cmpAfter[0].length);
    }
    const bi = /比 *$/.exec(before);
    const biAfter = /好|强|差|贵|便宜|怎么样|区别|如何/.exec(after);
    if (bi && biAfter) {
      const start = m.start - (before.length - bi.index);
      return spanHit(mt, start, m.end + biAfter.index + biAfter[0].length);
    }
  }
  return null;
}

function spanHit(mt: MappedText, start: number, end: number): TextHit {
  return { start, end, text: mt.norm.slice(start, end), quote: rawSlice(mt, start, end), groups: [mt.norm.slice(start, end)], groupRanges: [[start, end]] };
}

/** True when the clause around `pos` refuses a time slot ('明天不行', '周六没空'). */
function slotRefusedAt(mt: MappedText, pos: number): boolean {
  return REFUSED_SLOT_RE.test(clauseAt(mt, pos).text);
}

/** Availability words that are not negated ('不方便', '没空', '不太方便', '不可以' are excluded). */
function availabilityHits(mt: MappedText): TextHit[] {
  return findMatches(mt, AVAILABILITY_RE).filter(
    (h) => !/(?:不|没|不太)$/.test(mt.norm.slice(Math.max(0, h.start - 2), h.start)) && !slotRefusedAt(mt, h.start),
  );
}

function modelSpans(text: string): ModelSpan[] {
  return findModels(text).map((m) => ({ brand: m.brand, model: m.model, quote: m.quote, start: m.start, end: m.end }));
}

interface IntentAnalysis {
  intents: ConversationIntent[];
  evidence: Evidence[];
  hits: Partial<Record<ConversationIntent, TextHit>>;
}

function analyzeIntents(mt: MappedText, models: ModelSpan[]): IntentAnalysis {
  const hits: Partial<Record<ConversationIntent, TextHit>> = {};

  const price = findFirst(mt, PRICE_RE);
  if (price) hits.price_query = price;
  const inventory = findFirst(mt, INVENTORY_RE);
  if (inventory) hits.inventory_query = inventory;
  const cmp = comparisonHit(mt, models);
  if (cmp) hits.model_comparison = cmp;
  const finance = findFirst(mt, FINANCE_RE);
  if (finance) hits.finance_query = finance;
  const lease = findFirst(mt, LEASE_RE);
  if (lease) hits.lease_query = lease;
  const tradeIn = findFirst(mt, TRADE_IN_RE);
  if (tradeIn) hits.trade_in = tradeIn;

  const cancelled = findFirst(mt, VISIT_CANCEL_RE);
  const visit = findMatches(mt, VISIT_RE).find((h) => !isNegatedAt(mt, h.start) && !slotRefusedAt(mt, h.start));
  if (visit && !cancelled) hits.appointment = visit;
  else if (!cancelled && !price && !inventory) {
    const sameClause = (a: TextHit, b: TextHit) => clauseAt(mt, a.start).start === clauseAt(mt, b.start).start;
    const days = findMatches(mt, DAY_RE).filter((h) => !slotRefusedAt(mt, h.start));
    const avails = availabilityHits(mt);
    const day =
      days.find((d) => avails.some((a) => sameClause(a, d))) ??
      (days.length > 0 && avails.length > 0 && !REFUSED_SLOT_RE.test(mt.norm) ? days[0] : undefined);
    const meeting = [...findMatches(mt, CLOCK_RE), ...findMatches(mt, HHMM_RE)].find(
      (h) => !slotRefusedAt(mt, h.start) && MEETING_SUFFIX_RE.test(mt.norm.slice(h.end - (h.groups[7]?.length ?? 0), h.end + 3)),
    );
    const appointment = day ?? meeting;
    if (appointment) hits.appointment = appointment;
  }

  const phone = phoneHit(mt);
  const wechat = wechatHit(mt, phone?.phone);
  const cue = findMatches(mt, CONTACT_CUE_RE).find(
    (h) => !isNegatedAt(mt, h.start) && !CONTACT_REFUSAL_BEFORE_RE.test(mt.norm.slice(Math.max(0, h.start - 8), h.start)),
  );
  const contactHit = cue ?? phone?.hit ?? wechat?.hit;
  if (contactHit) hits.contact_exchange = contactHit;

  const hard = findFirst(mt, HARD_NEGATIVE_RE);
  const purchased = findFirst(mt, PURCHASED_RE);
  // refusals without an object of their own; declining a feature or a model ('不需要SUV', '不考虑Model 3了') is not one
  const standalone = (h: TextHit) => isStandaloneRefusal(mt, h.start, h.end);
  const disinterest = findMatches(mt, DISINTEREST_RE).find(standalone);
  const soft = findMatches(mt, SOFT_NEGATIVE_RE).find(standalone);
  const negative = hard ?? disinterest ?? purchased ?? soft;
  if (negative) hits.not_interested = negative;

  const intents = CONVERSATION_INTENTS.filter((i) => hits[i] !== undefined);
  const evidence: Evidence[] = intents.map((i) => ({ code: i, label: INTENT_LABELS[i], quote: hits[i]!.quote }));
  if (intents.length === 0) {
    const t = mt.raw.trim();
    if (t) evidence.push({ code: 'general', label: INTENT_LABELS.general, quote: Array.from(t).slice(0, 30).join('') });
    return { intents: ['general'], evidence, hits };
  }
  return { intents, evidence: dedupeEvidence(evidence), hits };
}

export function detectConversationIntents(text: string): { intents: ConversationIntent[]; evidence: Evidence[] } {
  const { intents, evidence } = analyzeIntents(mapText(text), modelSpans(text));
  return { intents, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Appointment time
// ─────────────────────────────────────────────────────────────────────────────

const CN_SMALL = '[零一二两三四五六七八九十]{1,3}';
const DAY_RE = new RegExp(
  [
    '(大后天|后天|明天|明日|明早|明晚|今天|今日|今晚)',
    '(这个|这|本|下下个|下下|下个|下)?(?:周|星期|礼拜)([一二三四五六日天末1-7])',
    `(\\d{1,2}|${CN_SMALL})月(\\d{1,2}|${CN_SMALL})(?:日|号)`,
    `(?<![\\d月.])(\\d{1,2}|${CN_SMALL})(?:号|日)(?!线|楼|门|店|院|口|车|码|位|机)`,
  ].join('|'),
);
const PERIOD_WORDS = '上午|早上|早晨|中午|下午|午后|傍晚|晚上|晚间|夜里|今晚|明晚|明早';
const CLOCK_RE = new RegExp(
  `(${PERIOD_WORDS})? *(\\d{1,2}|${CN_SMALL})(?:点|时)(?:(半)|(一刻)|(三刻)|(\\d{1,2}|${CN_SMALL})分?)?(钟|左右|前|后|过来|过去|到(?!店)|见)?`,
);
const HHMM_RE = new RegExp(`(${PERIOD_WORDS})? *(?<!\\d)([01]?\\d|2[0-3]):([0-5]\\d)(?!\\d)`);
const PERIOD_RE = new RegExp(`(${PERIOD_WORDS})`);
const PERIOD_DEFAULT: Record<string, [number, number]> = {
  上午: [10, 0],
  早上: [9, 0],
  早晨: [9, 0],
  明早: [9, 0],
  中午: [12, 0],
  下午: [14, 0],
  午后: [14, 0],
  傍晚: [17, 0],
  晚上: [19, 0],
  晚间: [19, 0],
  今晚: [19, 0],
  明晚: [19, 0],
  夜里: [20, 0],
};
const WEEKDAY_INDEX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };
/** Default wall-clock time when only a day is given (typical showroom morning slot; precision='date'). */
const DATE_ONLY_HOUR = 10;

interface LocalDate {
  y: number;
  m: number;
  d: number;
}

function addLocalDays(base: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d) + days * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function resolveDay(hit: TextHit, today: LocalDate, weekday: number): { date: LocalDate; period?: string } | null {
  const g = hit.groups;
  if (g[1]) {
    const word = g[1];
    const offset = word === '大后天' ? 3 : word === '后天' ? 2 : /^明/.test(word) ? 1 : 0;
    const period = word === '今晚' || word === '明晚' || word === '明早' ? word : undefined;
    return { date: addLocalDays(today, offset), period };
  }
  if (g[3]) {
    const target = WEEKDAY_INDEX[g[3]];
    if (!target) return null;
    const todayIdx = weekday === 0 ? 7 : weekday;
    const prefix = g[2] ?? '';
    let offset = target - todayIdx;
    if (prefix.startsWith('下下')) offset += 14;
    else if (prefix.startsWith('下')) offset += 7;
    else if (!prefix) {
      if (offset < 0) offset = g[3] === '末' && todayIdx === 7 ? 0 : offset + 7;
    }
    return { date: addLocalDays(today, offset) };
  }
  if (g[4] && g[5]) {
    const m = parseChineseNumber(g[4]);
    const d = parseChineseNumber(g[5]);
    if (m === null || d === null || m < 1 || m > 12 || d < 1) return null;
    let y = today.y;
    if (m < today.m || (m === today.m && d < today.d)) y += 1;
    if (d > daysInMonth(y, m)) return null;
    return { date: { y, m, d } };
  }
  if (g[6]) {
    const d = parseChineseNumber(g[6]);
    if (d === null || d < 1 || d > 31) return null;
    let { y, m } = today;
    if (d < today.d) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    if (d > daysInMonth(y, m)) return null;
    return { date: { y, m, d } };
  }
  return null;
}

function applyPeriod(hour: number, period: string | undefined): number {
  if (!period) return hour >= 1 && hour <= 7 ? hour + 12 : hour;
  if (/下午|午后|傍晚|晚上|晚间|夜里|今晚|明晚/.test(period)) return hour < 12 ? hour + 12 : hour;
  if (period === '中午') return hour >= 1 && hour <= 3 ? hour + 12 : hour;
  return hour;
}

function resolveClock(
  mt: MappedText,
  hasDay: boolean,
  accept: (hit: TextHit) => boolean = () => true,
): { hour: number; minute: number; hit: TextHit } | null {
  const hhmm = findMatches(mt, HHMM_RE).find(accept);
  if (hhmm) {
    const h = Number(hhmm.groups[2]);
    const min = Number(hhmm.groups[3]);
    return { hour: applyPeriod(h, hhmm.groups[1]), minute: min, hit: hhmm };
  }
  for (const h of findMatches(mt, CLOCK_RE)) {
    if (!accept(h)) continue;
    const hourText = h.groups[2] ?? '';
    const hour = parseChineseNumber(hourText);
    if (hour === null || hour > 24) continue;
    const period = h.groups[1];
    const chinese = !/^\d+$/.test(hourText);
    const suffix = h.groups[7];
    if (!period && chinese) {
      if (hourText === '一' && (/[快便宜多少早晚好大小近远高低贵慢稍有再差]$/.test(mt.norm.slice(0, h.start)) || /^[点儿]/.test(mt.norm.slice(h.end)))) continue;
      if (!hasDay && !suffix) continue;
    }
    let minute = 0;
    if (h.groups[3]) minute = 30;
    else if (h.groups[4]) minute = 15;
    else if (h.groups[5]) minute = 45;
    else if (h.groups[6]) {
      const mm = parseChineseNumber(h.groups[6]);
      if (mm !== null && mm < 60) minute = mm;
    }
    const resolved = applyPeriod(hour === 24 ? 0 : hour, period);
    if (resolved > 23) continue;
    return { hour: resolved, minute, hit: h };
  }
  return null;
}

/**
 * Resolve an appointment time expressed in Chinese relative to `now` in timezone `tz`.
 * Weeks start on Monday; a bare weekday already past this week means next week. When only a day is
 * given the time defaults to 10:00 local and `precision` is 'date'. Days / times inside a clause that refuses
 * the slot ('明天不行，下周六可以') are skipped.
 */
export function resolveAppointmentTime(
  text: string,
  now: Date,
  tz: string,
): { at: string | null; text: string | null; precision?: 'datetime' | 'date' } {
  const mt = mapText(text);
  const lp = localParts(now, tz);
  const today: LocalDate = { y: lp.year, m: lp.month, d: lp.day };
  const offered = (h: TextHit) => !slotRefusedAt(mt, h.start);

  let day: { date: LocalDate; period?: string; hit: TextHit } | null = null;
  for (const h of findMatches(mt, DAY_RE)) {
    if (!offered(h)) continue;
    const r = resolveDay(h, today, lp.weekday);
    if (r) {
      day = { ...r, hit: h };
      break;
    }
  }
  const clock = resolveClock(mt, day !== null, offered);
  const periodHit = clock
    ? null
    : (findMatches(mt, PERIOD_RE).find((h) => offered(h) && (!day || h.start >= day.hit.end || h.end <= day.hit.start)) ?? null);
  const period = periodHit?.groups[1] ?? day?.period;
  if (!day && !clock && !periodHit) return { at: null, text: null };

  let hour = DATE_ONLY_HOUR;
  let minute = 0;
  let precision: 'datetime' | 'date' = 'date';
  if (clock) {
    hour = clock.hour;
    minute = clock.minute;
    precision = 'datetime';
  } else if (period && PERIOD_DEFAULT[period]) {
    [hour, minute] = PERIOD_DEFAULT[period];
    precision = 'datetime';
  }

  let date = day?.date ?? today;
  let at = zonedTimeToUtc(date.y, date.m, date.d, hour, minute, tz);
  if (!day && at.getTime() <= now.getTime()) {
    date = addLocalDays(date, 1);
    at = zonedTimeToUtc(date.y, date.m, date.d, hour, minute, tz);
  }

  const parts = [day?.hit, clock?.hit, periodHit].filter((h): h is TextHit => !!h).sort((a, b) => a.start - b.start);
  let quote: string;
  if (parts.length === 1) quote = parts[0].quote;
  else {
    const gap = parts[parts.length - 1].start - parts[0].end;
    quote = gap <= 12 ? rawSlice(mt, parts[0].start, parts[parts.length - 1].end) : parts[0].quote;
  }
  return { at: at.toISOString(), text: quote, precision };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slots
// ─────────────────────────────────────────────────────────────────────────────

function tradeInVehicle(mt: MappedText): { value: string; start: number; end: number } | null {
  for (const h of findMatches(mt, TRADE_IN_VEHICLE_RE)) {
    const range = h.groupRanges[1];
    if (!range) continue;
    const captured = mt.norm.slice(range[0], range[1]);
    const cut = TRADE_IN_VEHICLE_CUT_RE.exec(captured);
    const len = cut ? cut.index : captured.length;
    if (len < 2) continue;
    const start = range[0];
    let end = range[0] + len;
    while (end > start && /\s/.test(mt.norm[end - 1])) end--;
    const normValue = mt.norm.slice(start, end);
    const raw = rawSlice(mt, start, end);
    const describesVehicle =
      VEHICLE_DESCRIPTOR_RE.test(normValue) || findBrands(raw).length > 0 || findModels(raw, { context: 'tesla' }).length > 0;
    if (!describesVehicle) continue;
    return { value: raw.trim(), start, end };
  }
  return null;
}

function financingState(mt: MappedText): boolean | undefined {
  const hits = findMatches(mt, FINANCE_TERMS_RE);
  const positive = hits.some((h) => !isNegatedAt(mt, h.start));
  const negated = hits.some((h) => isNegatedAt(mt, h.start));
  const full = findFirst(mt, FULL_PAYMENT_RE);
  const fullNegated = full ? isNegatedAt(mt, full.start) : false;
  if (negated || (full && !fullNegated && !positive)) return false;
  if (positive && (!full || fullNegated)) return true;
  return undefined;
}

function negatableState(mt: MappedText, re: RegExp): boolean | undefined {
  const hits = findMatches(mt, re);
  if (hits.length === 0) return undefined;
  if (hits.some((h) => !isNegatedAt(mt, h.start))) return true;
  return false;
}

export interface ExtractSlotsOptions {
  now: Date;
  tz: string;
  previous?: ConversationSlots;
  /** dealer-carried canonical models: preferred as the primary model when several are mentioned */
  carried_models?: readonly string[];
}

/** Extract conversation slots from one inbound message and merge them over `previous`. */
export function extractSlots(text: string, opts: ExtractSlotsOptions): ConversationSlots {
  const prev = opts.previous ?? {};
  const slots: ConversationSlots = { ...prev };
  if (prev.competing_models) slots.competing_models = [...prev.competing_models];
  const mt = mapText(text);
  const tiv = tradeInVehicle(mt);
  const outsideTradeIn = (s: { start: number; end: number }) => !tiv || s.end <= tiv.start || s.start >= tiv.end;
  const models = modelSpans(text).filter(outsideTradeIn);
  const analysis = analyzeIntents(mt, models);
  const intents = new Set(analysis.intents);
  const carried = new Set((opts.carried_models ?? []).map((m) => m.toLowerCase()));

  // vehicle
  const competing = new Set(slots.competing_models ?? []);
  if (models.length > 0) {
    let primary: ModelSpan | undefined;
    if (intents.has('model_comparison')) {
      if (models.length >= 2) {
        primary = models.find((m) => carried.has(m.model.toLowerCase())) ?? models.find((m) => m.model === prev.model) ?? models[0];
        for (const m of models) if (m.model !== primary.model) competing.add(m.model);
      } else if (models[0].model !== prev.model) {
        competing.add(models[0].model);
      }
    } else {
      primary = models.find((m) => carried.has(m.model.toLowerCase())) ?? models[0];
    }
    if (primary) {
      if (primary.model !== prev.model) delete slots.trim;
      slots.model = primary.model;
    }
  }
  const trims = findTrims(text, slots.model);
  const trim = trims[0] ?? (slots.model ? undefined : findTrims(text)[0]);
  if (trim) {
    slots.trim = trim.trim;
    if (!slots.model) slots.model = trim.model;
  }
  if (slots.model) competing.delete(slots.model);
  if (competing.size > 0) slots.competing_models = [...competing];

  // budget, location, timeframe
  const budget = parseBudgetMapped(mt);
  if (budget) {
    delete slots.budget_min;
    delete slots.budget_max;
    if (budget.budget_min !== undefined) slots.budget_min = budget.budget_min;
    if (budget.budget_max !== undefined) slots.budget_max = budget.budget_max;
  }
  const locations = findLocationsMapped(mt).filter(outsideTradeIn);
  const loc = locations.find((l) => l.city) ?? locations[0];
  if (loc) slots.location = loc.city ?? loc.province;
  // calendar expressions ('10月底', '国庆前') are placed relative to the message time in the dealer timezone
  const timeframe = detectTimeframeMapped(mt, { now: opts.now, tz: opts.tz });
  if (timeframe) slots.purchase_timeframe = timeframe.timeframe;

  // payment & trade-in
  const financing = financingState(mt);
  if (financing !== undefined) slots.financing = financing;
  const leasing = negatableState(mt, LEASE_RE);
  if (leasing !== undefined) slots.leasing = leasing;
  let tradeIn = negatableState(mt, TRADE_IN_RE);
  if (findFirst(mt, NO_TRADE_IN_RE)) tradeIn = false;
  if (tiv && tradeIn !== false) {
    slots.trade_in_vehicle = tiv.value;
    tradeIn = true;
  }
  if (tradeIn !== undefined) slots.trade_in = tradeIn;

  // contact
  const contact = detectContactInfo(text);
  if (contact.phone) slots.contact_phone = contact.phone;
  if (contact.wechat) slots.contact_wechat = contact.wechat;

  // appointment
  if (intents.has('appointment')) slots.appointment_intent = true;
  if (findFirst(mt, VISIT_CANCEL_RE) || intents.has('not_interested')) slots.appointment_intent = false;
  if (slots.appointment_intent) {
    const when = resolveAppointmentTime(text, opts.now, opts.tz);
    if (when.text) {
      slots.appointment_time_text = when.text;
      if (when.at) slots.appointment_at = when.at;
    }
  }
  return slots;
}

/** Convenience: intents + evidence + merged slots for one inbound message. */
export function analyzeConversationMessage(
  text: string,
  opts: ExtractSlotsOptions,
): { intents: ConversationIntent[]; evidence: Evidence[]; slots: ConversationSlots } {
  const { intents, evidence } = detectConversationIntents(text);
  return { intents, evidence, slots: extractSlots(text, opts) };
}
