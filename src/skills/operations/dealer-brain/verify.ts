import type { AppContext } from '../../../app/context.ts';
import { formatCny, normalizeText } from '../../../core/text.ts';
import type { Dealer, DealerKnowledge, FactRef, Inventory, Offer, Vehicle } from '../../../core/types.ts';
import { getDealer, getProhibitedClaims, isKnowledgeActive, isOfferActive, offerAppliesToVehicle } from './queries.ts';
import { COLOR_CHARS, colorMatches, dealerTz, localDateOf, matchKey } from './shared.ts';

export interface ClaimCheck {
  passed: boolean;
  issues: string[];
  verified: FactRef[];
  unverified_claims: string[];
}

export type ClaimType = 'money' | 'rate' | 'term' | 'down_payment' | 'inventory' | 'date';

/** What a money amount is claimed to be, from the nearest keyword before it. */
export type MoneyRole = 'price' | 'discount' | 'monthly' | 'any';

export interface ExtractedClaim {
  type: ClaimType;
  /** matched token, e.g. '35.39万', '九万', '0息', '36期', '首付3成', '现车', '9月30日' */
  raw: string;
  /** shown in issues / unverified_claims (landing prices include their context, stock claims their count) */
  display: string;
  index: number;
  value?: number;
  year?: number;
  month?: number;
  day?: number;
  stock?: 'in_stock' | 'in_transit' | 'any';
  landing?: boolean;
  /** money: 指导价/售价 → price · 优惠/补贴 → discount · 月供 or '/月' → monthly · otherwise any */
  role?: MoneyRole;
  /** inventory: number of cars stated next to the stock word ('现车2台', '有3台现车') */
  quantity?: number;
  /** inventory: colours stated in the same clause ('白外红内', '矿石白外观、珊瑚红内饰', '灰色在途') */
  colours?: { exterior: string; interior?: string }[];
}

const CLAIM_LABEL: Record<ClaimType, string> = {
  money: '金额',
  rate: '利率',
  term: '分期期数',
  down_payment: '首付比例',
  inventory: '库存/现车',
  date: '截止日期',
};

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

function isClauseBreak(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === undefined) return true;
  if ('，。；！？;!?\n'.includes(ch)) return true;
  if (ch === ',') return !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  return false;
}

/** Up to `max` characters immediately before `index`, never crossing a clause boundary. */
function clausePrefix(text: string, index: number, max = 12): string {
  let start = index;
  while (start > 0 && index - start < max && !isClauseBreak(text, start - 1)) start--;
  return text.slice(start, index);
}

/** Text after `end` up to the end of the clause, plus the terminating character. */
function clauseSuffix(text: string, end: number): { rest: string; terminator: string } {
  let i = end;
  while (i < text.length && !isClauseBreak(text, i)) i++;
  return { rest: text.slice(end, i), terminator: text[i] ?? '' };
}

/** The whole clause containing `index`. */
function clauseAt(text: string, index: number): string {
  let start = index;
  while (start > 0 && !isClauseBreak(text, start - 1)) start--;
  let end = index;
  while (end < text.length && !isClauseBreak(text, end)) end++;
  return text.slice(start, end);
}

const SENTENCE_BREAKS = '。！？!?；;\n';

/** The sentence containing `index` (commas do not end a sentence; 。！？； and new lines do). */
function sentenceAt(text: string, index: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_BREAKS.includes(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !SENTENCE_BREAKS.includes(text[end])) end++;
  return text.slice(start, end);
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_MULTIPLIER: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function parseCnInteger(s: string): number {
  if (!s) return 0;
  const chars = [...s];
  if (!chars.some((ch) => ch in CN_MULTIPLIER)) return Number(chars.map((ch) => CN_DIGIT[ch] ?? 0).join(''));
  let total = 0;
  let current = 0;
  for (const ch of chars) {
    if (ch in CN_MULTIPLIER) {
      total += (current || 1) * CN_MULTIPLIER[ch];
      current = 0;
    } else current = CN_DIGIT[ch] ?? 0;
  }
  return total + current;
}

/** '九' → 9 · '十二' → 12 · '三十五点三九' → 35.39 · '两万五千' → 25000 */
function parseCnNumber(s: string): number {
  const [intPart, decPart] = s.split('点');
  let n: number;
  if (intPart.includes('万')) {
    const [high, low] = intPart.split('万');
    n = parseCnInteger(high) * 10_000 + parseCnInteger(low);
  } else n = parseCnInteger(intPart);
  if (decPart) n += Number(`0.${[...decPart].map((ch) => CN_DIGIT[ch] ?? 0).join('')}`);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const PER_MONTH = String.raw`(?:\s*(?:\/|每)\s*月)?`;
const ARABIC_MONEY_RE = new RegExp(
  String.raw`(?<![0-9.,])${NUM}\s*(万元|万块钱|万块|万|千元|千块钱|千块|千|元|块钱|块|[wW](?![A-Za-z0-9]))${PER_MONTH}`,
  'g',
);
const YUAN_SIGN_RE = new RegExp(String.raw`¥\s*${NUM}(?![\d.,]|\s*(?:万|千|元|块|[wW](?![A-Za-z0-9])))${PER_MONTH}`, 'g');
const CN_NUMERALS = '零〇一二两三四五六七八九十百千';
const CN_MONEY_RE = new RegExp(
  `(?<![${CN_NUMERALS}万])([${CN_NUMERALS}]+(?:万[${CN_NUMERALS}]+)?(?:点[零〇一二三四五六七八九]+)?)\\s*(万元|万块钱|万块|万|元|块钱|块)${PER_MONTH}`,
  'gu',
);
const NON_MONEY_FOLLOWERS = [
  '公里', '千米', 'km', '米', '人', '次', '辆', '台', '位', '条', '篇', '个', '名', '粉', '阅读', '播放', '字', '步',
  '快充', '瓦', '转', '毫安', '级',
];

const LANDING_WORDS = ['落地', '到手价', '全包价', '裸车价', '成交价'];
const LANDING_AFTER_RE = /^\s*(?:左右|上下|以内|以下|起)?\s*(?:就能|就可以|即可|可以|能|可|就)?\s*(?:全款)?\s*(?:落地|到手|全包)/;
const ROLE_WORDS: [MoneyRole, string[]][] = [
  ['price', ['指导价', '官方价', '官价', '厂商价', '售价', '标价', '车价', '原价', '报价']],
  ['discount', ['优惠', '立减', '直降', '降价', '让利', '补贴', '减免', '现金', '返现', '抵扣', '便宜', '降了', '减']],
  ['monthly', ['月供', '月付', '每月', '月租', '租金']],
];

function moneyRole(prefix: string, raw: string): MoneyRole {
  if (/(?:\/|每)\s*月$/u.test(raw)) return 'monthly';
  let best: MoneyRole = 'any';
  let bestEnd = -1;
  for (const [role, words] of ROLE_WORDS) {
    for (const w of words) {
      const at = prefix.lastIndexOf(w);
      if (at >= 0 && at + w.length > bestEnd) {
        bestEnd = at + w.length;
        best = role;
      }
    }
  }
  return best;
}

const PCT_RE = /(?<![0-9.])(\d+(?:\.\d+)?)\s*%/g;
const ZERO_RATE_RE = /(?<![0-9.])(?:0|零)\s*(?:息|利率|利息)|免息/g;
const TERM_RE = /(?<![0-9.第])(\d{1,3})\s*期(?!间)/g;
const DOWN_CHENG_RE = /首付(?:比例)?(?:低至|仅需|只需|最低|只要|仅)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十])\s*成/g;
// the digit look-behind applies to Arabic digits only: 'i3三成首付' must still extract 三成
const DOWN_CHENG_BEFORE_RE = /((?<![0-9.])\d+(?:\.\d+)?|[一二两三四五六七八九])\s*成首付/g;
const ZERO_DOWN_RE = /(?:零|0)首付/g;

const INVENTORY_RE = /现车|现货|有货|库存|在途/g;
const FAR_NEGATIONS = ['暂无', '没有', '暂未', '尚无', '暂时没', '并无', '已无', '无法提供'];
const NEAR_NEGATION_RE = /(?:无|没|非|不是|缺)$/u;
const NEGATED_AFTER_RE = /^\s*(?:已经|已|都|也)?\s*(?:售罄|卖完|没了|没有了|清空)/u;
const INQUIRIES = ['查', '确认', '核实', '咨询', '了解', '询问', '问问', '问一下'];
const QUESTION_RE = /吗|(?<![什怎这那多])么|呢\s*$/u;
const QTY_AFTER_RE = /^\s*(\d+|[一二两三四五六七八九十])\s*(?:台|辆)/u;
const QTY_BEFORE_RE = /(\d+|[一二两三四五六七八九十])\s*(?:台|辆)(?:的)?\s*$/u;

const C = `[${COLOR_CHARS}]`;
const PAIR_COMPACT_RE = new RegExp(`(${C})色?外(?!观)(${C})色?内`, 'gu');
const PAIR_LONG_RE = new RegExp(`(${C})色?外观[、\\s]*\\p{Script=Han}{0,3}?(${C})色?内饰`, 'gu');
const SINGLE_COLOUR_BEFORE_RE = new RegExp(`(${C})色(?:的|款)?(?:车)?(?:有)?\\s*$`, 'u');

const ISO_DATE_RE = /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g;
const CN_DATE_RE = /(?<!\d)(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/g;
const EXPIRY_PREFIXES = ['截止', '截至', '有效期', '至', '~', '-', '—', '到'];
const EXPIRY_SUFFIXES = ['前', '止', '截止', '到期', '结束', '为止', '之前', '起', '至', '-', '~', '—'];

const cnOrArabic = (s: string) => CN_DIGIT[s] ?? (s === '十' ? 10 : parseFloat(s));
const validMonthDay = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;

function stockColours(text: string, index: number): { exterior: string; interior?: string }[] {
  const clause = clauseAt(text, index);
  const pairs: { exterior: string; interior?: string }[] = [];
  for (const m of clause.matchAll(PAIR_COMPACT_RE)) pairs.push({ exterior: m[1], interior: m[2] });
  for (const m of clause.matchAll(PAIR_LONG_RE)) pairs.push({ exterior: m[1], interior: m[2] });
  if (pairs.length > 0) return pairs;
  const single = SINGLE_COLOUR_BEFORE_RE.exec(clausePrefix(text, index, 8));
  return single ? [{ exterior: single[1] }] : [];
}

/**
 * Extract every factual claim (money, rate, term, down payment, inventory, expiry date) from text.
 * Money covers '35.39万', '9万', '8000元', '8,000元', '5999元/月', '9w', '8000块', '¥90,000' and Chinese numerals
 * ('九万', '三十五点三九万'); idioms ('千万', '十万火急') and non-money units ('1万公里', '200W快充') are ignored.
 */
export function extractClaims(input: string): ExtractedClaim[] {
  const text = input.normalize('NFKC');
  const out: ExtractedClaim[] = [];

  const pushMoney = (index: number, matched: string, value: number) => {
    const end = index + matched.length;
    const after = text.slice(end).replace(/^(?:多|余|左右|\+)/u, '');
    if (NON_MONEY_FOLLOWERS.some((f) => after.startsWith(f))) return;
    const raw = matched.replace(/\s+/g, '');
    const prefix = clausePrefix(text, index, 10);
    const landingAt = Math.max(...LANDING_WORDS.map((w) => prefix.lastIndexOf(w)));
    const landingAfter = LANDING_AFTER_RE.exec(text.slice(end));
    const landing = landingAt >= 0 || landingAfter !== null;
    const display =
      landingAt >= 0
        ? text.slice(index - (prefix.length - landingAt), end)
        : landingAfter
          ? `${raw}${landingAfter[0].replace(/\s+/g, '')}`
          : raw;
    out.push({ type: 'money', raw, display, index, value: Math.round(value), landing, role: moneyRole(prefix, raw) });
  };

  for (const m of text.matchAll(ARABIC_MONEY_RE)) {
    const unit = m[2];
    const n = parseFloat(m[1].replace(/,/g, ''));
    const factor = unit.startsWith('万') || unit === 'w' || unit === 'W' ? 10_000 : unit.startsWith('千') ? 1000 : 1;
    pushMoney(m.index, m[0], n * factor);
  }
  for (const m of text.matchAll(YUAN_SIGN_RE)) pushMoney(m.index, m[0], parseFloat(m[1].replace(/,/g, '')));
  for (const m of text.matchAll(CN_MONEY_RE)) {
    const numeral = m[1];
    const value = parseCnNumber(numeral) * (m[2].startsWith('万') ? 10_000 : 1);
    if (value < 100) continue; // '一块去', '两块钱' are not dealership amounts
    const hasDigit = /[一二两三四五六七八九]/u.test(numeral);
    if (!hasDigit && moneyRole(clausePrefix(text, m.index, 10), m[0]) === 'any') continue; // '千万别', '十万火急'
    pushMoney(m.index, m[0], value);
  }

  for (const m of text.matchAll(PCT_RE)) {
    const value = parseFloat(m[1]) / 100;
    const end = m.index + m[0].length;
    const isDown = clausePrefix(text, m.index, 8).includes('首付') || /^\s*首付/u.test(text.slice(end));
    const raw = m[0].replace(/\s+/g, '');
    out.push({ type: isDown ? 'down_payment' : 'rate', raw, display: isDown ? `首付${raw}` : raw, index: m.index, value });
  }
  for (const m of text.matchAll(ZERO_RATE_RE)) {
    out.push({ type: 'rate', raw: m[0], display: m[0], index: m.index, value: 0 });
  }
  for (const m of text.matchAll(TERM_RE)) {
    const raw = m[0].replace(/\s+/g, '');
    out.push({ type: 'term', raw, display: raw, index: m.index, value: Number(m[1]) });
  }
  for (const re of [DOWN_CHENG_RE, DOWN_CHENG_BEFORE_RE]) {
    for (const m of text.matchAll(re)) {
      const raw = m[0].replace(/\s+/g, '');
      out.push({ type: 'down_payment', raw, display: raw, index: m.index, value: cnOrArabic(m[1]) / 10 });
    }
  }
  for (const m of text.matchAll(ZERO_DOWN_RE)) {
    out.push({ type: 'down_payment', raw: m[0], display: m[0], index: m.index, value: 0 });
  }

  for (const m of text.matchAll(INVENTORY_RE)) {
    const end = m.index + m[0].length;
    const prefix = clausePrefix(text, m.index, 60);
    if (FAR_NEGATIONS.some((n) => prefix.includes(n)) || NEAR_NEGATION_RE.test(prefix)) continue;
    if (INQUIRIES.some((n) => prefix.includes(n))) continue;
    const { rest, terminator } = clauseSuffix(text, end);
    if (NEGATED_AFTER_RE.test(rest)) continue;
    if (QUESTION_RE.test(rest) || terminator === '？' || terminator === '?') continue;
    const stock = m[0] === '在途' ? 'in_transit' : m[0] === '库存' ? 'any' : 'in_stock';
    const after = QTY_AFTER_RE.exec(rest);
    const before = after ? null : QTY_BEFORE_RE.exec(clausePrefix(text, m.index, 8));
    const quantity = after ? cnOrArabic(after[1]) : before ? cnOrArabic(before[1]) : undefined;
    const display = after ? `${m[0]}${after[0].replace(/\s+/g, '')}` : before ? `${before[0].replace(/\s+/g, '')}${m[0]}` : m[0];
    out.push({ type: 'inventory', raw: m[0], display, index: m.index, stock, quantity, colours: stockColours(text, m.index) });
  }

  for (const m of text.matchAll(ISO_DATE_RE)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!validMonthDay(month, day)) continue;
    out.push({ type: 'date', raw: m[0], display: m[0], index: m.index, year: Number(m[1]), month, day });
  }
  for (const m of text.matchAll(CN_DATE_RE)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!validMonthDay(month, day)) continue;
    const prefix = clausePrefix(text, m.index, 8);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 4);
    const expiryContext =
      EXPIRY_PREFIXES.some((p) => prefix.endsWith(p) || (p.length > 1 && prefix.includes(p))) ||
      EXPIRY_SUFFIXES.some((s) => after.startsWith(s));
    if (!expiryContext) continue;
    out.push({ type: 'date', raw: m[0], display: m[0], index: m.index, year: m[1] ? Number(m[1]) : undefined, month, day });
  }

  return out.sort((a, b) => a.index - b.index);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

/** Boundary-aware containment: '9万' is not contained in '40.39万'. */
function containsToken(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!n) return false;
  let from = 0;
  while (true) {
    const at = h.indexOf(n, from);
    if (at < 0) return false;
    const before = h[at - 1] ?? '';
    const after = h[at + n.length] ?? '';
    const okBefore = !/^\d/.test(n) || !/[0-9.,]/.test(before);
    const okAfter = !/\d$/.test(n) || !/[0-9]/.test(after);
    if (okBefore && okAfter) return true;
    from = at + 1;
  }
}

const isAsciiAlnum = (ch: string | undefined) => ch !== undefined && /[a-z0-9]/.test(ch);

/** Word-bounded containment for catalog tokens: 'x3' is not mentioned in 'ix3', 'edrive35' not in 'edrive35l'. */
function mentions(haystack: string, token: string): boolean {
  if (!token) return false;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(token, from);
    if (at < 0) return false;
    const okBefore = !isAsciiAlnum(token[0]) || !isAsciiAlnum(haystack[at - 1]);
    const okAfter = !isAsciiAlnum(token[token.length - 1]) || !isAsciiAlnum(haystack[at + token.length]);
    if (okBefore && okAfter) return true;
    from = at + 1;
  }
}

/**
 * Catalog vehicles named in a sentence. A named trim narrows its model to that trim; a bare model name means
 * every trim of the model. Returns null when the sentence names no catalog vehicle (no scoping).
 */
function mentionedVehicles(sentence: string, catalog: Vehicle[]): Set<string> | null {
  const s = normalizeText(sentence);
  const models = new Map<string, { all: string[]; trims: string[]; named: boolean }>();
  for (const veh of catalog) {
    const key = `${matchKey(veh.brand)}|${matchKey(veh.model)}`;
    const entry = models.get(key) ?? { all: [], trims: [], named: false };
    entry.all.push(veh.id);
    if ([veh.model, veh.model_zh].some((t) => mentions(s, normalizeText(t)))) entry.named = true;
    if ([veh.trim, ...veh.aliases].some((t) => mentions(s, normalizeText(t)))) entry.trims.push(veh.id);
    models.set(key, entry);
  }
  const out = new Set<string>();
  for (const entry of models.values()) {
    if (entry.trims.length > 0) for (const id of entry.trims) out.add(id);
    else if (entry.named) for (const id of entry.all) out.add(id);
  }
  return out.size > 0 ? out : null;
}

interface ResolvedRef {
  ref: FactRef;
  valid: boolean;
  reason: string;
  vehicle?: Vehicle;
  inventory?: Inventory;
  offer?: Offer;
  knowledge?: DealerKnowledge;
  dealer?: Dealer;
  blob: string;
}

function resolveRef(ctx: AppContext, dealer: Dealer, ref: FactRef, now: Date): ResolvedRef {
  const invalid = (reason: string): ResolvedRef => ({ ref, valid: false, reason, blob: '' });
  switch (ref.kind) {
    case 'vehicle': {
      const row = ctx.db.table('vehicles').get(ref.id);
      if (!row) return invalid('车型记录不存在');
      if (row.group_id !== dealer.group_id) return invalid('车型不属于该经销商集团');
      const brands = dealer.brands.map(matchKey);
      if (brands.length > 0 && !brands.includes(matchKey(row.brand)) && !brands.includes(matchKey(row.brand_zh)))
        return invalid(`门店不经营品牌${row.brand}`);
      const blob = [row.brand, row.brand_zh, row.model, row.model_zh, row.trim, ...row.aliases, ...row.highlights, ...Object.values(row.specs).map(String)].join('\n');
      return { ref, valid: true, reason: '', vehicle: row, blob };
    }
    case 'inventory': {
      const row = ctx.db.table('inventory').get(ref.id);
      if (!row) return invalid('库存记录不存在');
      if (row.dealer_id !== dealer.id) return invalid('库存不属于该门店');
      if (!(row.status === 'in_stock' || row.status === 'in_transit') || row.quantity <= 0)
        return invalid(`库存当前不可售（状态${row.status}，数量${row.quantity}）`);
      return { ref, valid: true, reason: '', inventory: row, blob: [row.exterior_color, row.interior_color].join('\n') };
    }
    case 'offer': {
      const row = ctx.db.table('offers').get(ref.id);
      if (!row) return invalid('优惠记录不存在');
      if (row.dealer_id !== dealer.id) return invalid('优惠不属于该门店');
      if (!isOfferActive(row, dealer, now)) return invalid(`优惠「${row.title}」不在有效期内（${row.valid_from}~${row.valid_until}）`);
      return { ref, valid: true, reason: '', offer: row, blob: [row.title, row.description, row.conditions].join('\n') };
    }
    case 'knowledge': {
      const row = ctx.db.table('dealer_knowledge').get(ref.id);
      if (!row) return invalid('知识记录不存在');
      if (row.group_id !== dealer.group_id || (row.dealer_id !== null && row.dealer_id !== dealer.id))
        return invalid('知识不属于该门店');
      if (!isKnowledgeActive(row, dealer, now)) return invalid(`「${row.title}」不在有效期内`);
      return { ref, valid: true, reason: '', knowledge: row, blob: [row.title, row.content, JSON.stringify(row.data)].join('\n') };
    }
    case 'dealer': {
      if (ref.id !== dealer.id) return invalid('引用的不是该门店');
      return {
        ref,
        valid: true,
        reason: '',
        dealer,
        blob: [dealer.name, dealer.city, dealer.province, dealer.address, dealer.business_hours, dealer.phone ?? ''].join('\n'),
      };
    }
    default:
      return invalid(`未知的事实类型 ${String((ref as FactRef).kind)}`);
  }
}

/** Which kinds of Dealer Brain rows can back a claim at all. */
function kindCompatible(res: ResolvedRef, claim: ExtractedClaim): boolean {
  const kind = res.ref.kind;
  switch (claim.type) {
    case 'inventory':
      return kind === 'inventory';
    case 'money':
      switch (claim.role) {
        case 'price':
          return kind === 'vehicle' || kind === 'inventory';
        case 'discount':
        case 'monthly':
          return kind === 'offer' || kind === 'knowledge';
        default:
          return kind === 'vehicle' || kind === 'inventory' || kind === 'offer' || kind === 'knowledge';
      }
    case 'rate':
    case 'term':
    case 'down_payment':
    case 'date':
      return kind === 'offer' || kind === 'knowledge';
  }
}

function inScope(res: ResolvedRef, subjects: Set<string> | null, byId: Map<string, Vehicle>): boolean {
  if (!subjects) return true;
  if (res.vehicle) return subjects.has(res.vehicle.id);
  if (res.inventory) return subjects.has(res.inventory.vehicle_id);
  if (res.offer) {
    const offer = res.offer;
    if (offer.vehicle_id) return subjects.has(offer.vehicle_id);
    if (offer.model) {
      return [...subjects].some((id) => {
        const veh = byId.get(id);
        return veh !== undefined && offerAppliesToVehicle(offer, veh);
      });
    }
  }
  return true;
}

const approx = (a: number | null | undefined, b: number | undefined) =>
  a !== null && a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6;

function moneyEquals(rowValue: number | null | undefined, claim: ExtractedClaim): boolean {
  if (rowValue === null || rowValue === undefined) return false;
  if (rowValue === claim.value) return true;
  const compact = claim.raw.replace(/万元$/u, '万').replace(/(?:\/|每)月$/u, '');
  return formatCny(rowValue) === compact;
}

function dateEquals(value: string | null | undefined, claim: ExtractedClaim, tz: string): boolean {
  if (!value) return false;
  const [y, m, d] = localDateOf(value, tz).split('-').map(Number);
  return m === claim.month && d === claim.day && (claim.year === undefined || claim.year === y);
}

/** Does this (valid) row support the claim's value? Scope and quantity are checked by the caller. */
function refSupports(res: ResolvedRef, claim: ExtractedClaim, tz: string): boolean {
  if (!kindCompatible(res, claim)) return false;
  const blobHas = res.blob !== '' && containsToken(res.blob, claim.raw);
  const textual = blobHas && (res.offer !== undefined || res.knowledge !== undefined);
  switch (claim.type) {
    case 'inventory': {
      const inv = res.inventory!;
      if (claim.stock === 'in_stock' && inv.status !== 'in_stock') return false;
      if (claim.stock === 'in_transit' && inv.status !== 'in_transit') return false;
      if (
        claim.colours &&
        claim.colours.length > 0 &&
        !claim.colours.some(
          (c) => colorMatches(c.exterior, inv.exterior_color) && (!c.interior || colorMatches(c.interior, inv.interior_color)),
        )
      )
        return false;
      return true;
    }
    case 'money':
      switch (claim.role) {
        case 'price':
          // 指导价, the price the store is actually asking today (车型库 current_price), or this car's own list price.
          return moneyEquals(res.vehicle?.msrp, claim) || moneyEquals(res.vehicle?.current_price, claim) || moneyEquals(res.inventory?.list_price, claim);
        case 'discount':
          return (res.offer !== undefined && res.offer.type !== 'lease' && moneyEquals(res.offer.amount, claim)) || textual;
        case 'monthly':
          return (res.offer?.type === 'lease' && moneyEquals(res.offer.amount, claim)) || textual;
        default:
          return (
            blobHas ||
            moneyEquals(res.vehicle?.msrp, claim) ||
            moneyEquals(res.vehicle?.current_price, claim) ||
            moneyEquals(res.inventory?.list_price, claim) ||
            moneyEquals(res.offer?.amount, claim)
          );
      }
    case 'rate':
      return approx(res.offer?.apr, claim.value) || textual;
    case 'term':
      return (res.offer?.term_months !== undefined && res.offer.term_months === claim.value) || textual;
    case 'down_payment':
      return approx(res.offer?.down_payment_pct, claim.value) || textual;
    case 'date':
      return (
        dateEquals(res.offer?.valid_until, claim, tz) ||
        dateEquals(res.offer?.valid_from, claim, tz) ||
        dateEquals(res.knowledge?.valid_until, claim, tz) ||
        dateEquals(res.knowledge?.valid_from, claim, tz) ||
        textual
      );
  }
}

/** A declared ref must not assert something its own row contradicts (wrong number, other vehicle, landing price). */
function refContradiction(res: ResolvedRef, catalog: Vehicle[], byId: Map<string, Vehicle>, tz: string): string | null {
  if (!inScope(res, mentionedVehicles(res.ref.claim, catalog), byId)) return '引用内容提到的车型与该记录不符';
  for (const claim of extractClaims(res.ref.claim)) {
    if (claim.type === 'money' && claim.landing) return `包含落地价表述「${claim.display}」`;
    if (!kindCompatible(res, claim)) continue;
    if (!refSupports(res, claim, tz)) return `「${claim.display}」与记录数据不符`;
  }
  return null;
}

/**
 * Verify every factual claim in `text` against the DECLARED FactRefs. A claim passes only when a declared ref
 * (a) exists, (b) belongs to this dealer, (c) is currently valid / sellable, (d) is the right kind of fact for
 * the claim (指导价 ← vehicle/inventory price, 优惠 ← offer amount, 月供 ← lease amount, 现车 ← inventory),
 * (e) covers the vehicle named in the same sentence and the stated colours, and (f) matches numerically; stated
 * car counts must not exceed the backing stock. Declared refs that are invalid or contradict their own row,
 * landing / transaction prices and prohibited phrases are issues. Text with no factual claims passes.
 */
export function verifyClaims(ctx: AppContext, dealerId: string, text: string, declared: FactRef[]): ClaimCheck {
  const dealer = getDealer(ctx, dealerId);
  const tz = dealerTz(dealer);
  const now = ctx.clock.now();
  const catalog = ctx.db.table('vehicles').findMany({ group_id: dealer.group_id });
  const byId = new Map(catalog.map((veh) => [veh.id, veh]));
  const issues: string[] = [];
  const unverified: string[] = [];
  const verified = new Map<string, FactRef>();
  const refKey = (r: FactRef) => `${r.kind}:${r.id}:${r.claim}`;
  const refLabel = (r: FactRef) => `${r.kind} ${r.id}「${r.claim}」`;

  const resolved = declared.map((ref) => resolveRef(ctx, dealer, ref, now));
  const usable: ResolvedRef[] = [];
  for (const r of resolved) {
    if (!r.valid) {
      issues.push(`事实引用无效（${refLabel(r.ref)}）：${r.reason}`);
      continue;
    }
    const contradiction = refContradiction(r, catalog, byId, tz);
    if (contradiction) {
      issues.push(`事实引用与门店数据不符（${refLabel(r.ref)}）：${contradiction}`);
      continue;
    }
    usable.push(r);
  }

  const nfkc = text.normalize('NFKC');
  for (const claim of extractClaims(text)) {
    if (claim.type === 'money' && claim.landing) {
      issues.push(`「${claim.display}」涉及落地价/到手价：落地价需结合上牌、保险、金融方案单独核算，不能在内容中承诺`);
      unverified.push(claim.display);
      continue;
    }
    const subjects = mentionedVehicles(sentenceAt(nfkc, claim.index), catalog);
    const backing = usable.filter((r) => inScope(r, subjects, byId) && refSupports(r, claim, tz));
    if (backing.length === 0) {
      issues.push(`无法核实的${CLAIM_LABEL[claim.type]}表述「${claim.display}」：没有对应且有效的门店数据`);
      unverified.push(claim.display);
      continue;
    }
    if (claim.type === 'inventory' && claim.quantity !== undefined) {
      const stocked = new Map<string, number>();
      for (const r of backing) if (r.inventory) stocked.set(r.inventory.id, r.inventory.quantity);
      const total = [...stocked.values()].reduce((a, b) => a + b, 0);
      if (total < claim.quantity) {
        issues.push(`库存数量表述「${claim.display}」超过门店可售数量（${total}台）`);
        unverified.push(claim.display);
        continue;
      }
    }
    for (const r of backing) verified.set(refKey(r.ref), r.ref);
  }

  const normalizedText = normalizeText(text);
  for (const r of usable) {
    if (r.ref.claim && normalizedText.includes(normalizeText(r.ref.claim))) verified.set(refKey(r.ref), r.ref);
  }

  for (const p of getProhibitedClaims(ctx, dealerId)) {
    if (normalizedText.includes(normalizeText(p.phrase))) issues.push(`包含禁用表述「${p.phrase}」：${p.reason}`);
  }

  return {
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    verified: [...verified.values()],
    unverified_claims: [...new Set(unverified)],
  };
}
