import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { meaningfulChars, normalizeText, round, textSimilarity } from '../../../core/text.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';

/**
 * Platform compliance rules (pure).
 *
 * Xiaohongshu forbids steering users off-platform: since 2025-01-07 professional accounts may not put
 * phone numbers / WeChat ids in messages (contact exchange must use 留资卡 / 名片). Content must also
 * respect the PRC Advertising Law (no absolute superlatives) and the dealer's own prohibited claims.
 * Every issue carries a verbatim quote of the ORIGINAL text so reviewers can see exactly what failed.
 */

export interface RuleIssue {
  code: string;
  message: string;
  quote?: string;
}

export const RULE_CHANNELS = ['dm', 'comment', 'post'] as const;
export type RuleChannel = (typeof RULE_CHANNELS)[number];

export interface PlatformRuleOptions {
  prohibited: { phrase: string; reason: string }[];
  max_length: number;
  channel: RuleChannel;
}

export const CONTACT_LEAK_CODES = [
  'contact_phone',
  'contact_wechat',
  'contact_qq',
  'contact_email',
  'contact_link',
  'off_platform_solicitation',
] as const;
export type ContactLeakCode = (typeof CONTACT_LEAK_CODES)[number];

/** Built-in 广告法 absolute terms (checked for every channel). */
export const AD_LAW_ABSOLUTE_TERMS: readonly string[] = [
  '全网最低',
  '最低价',
  '史上最低',
  '价格最低',
  '最便宜',
  '第一品牌',
  '全国第一',
  '销量第一',
  '国家级',
  '最佳',
  '最好的',
  '顶级',
  '绝对',
  '100%保证',
  '百分百保证',
  '百分之百保证',
  '独家',
  '万能',
];

/** More than this many emoji reads as marketing spam. */
export const MAX_EMOJI = 8;

/** Conservative default length limits used by the `compliance` skill when none is supplied. */
export const DEFAULT_MAX_LENGTH: Record<RuleChannel, number> = { dm: 300, comment: 280, post: 1000 };

const CONTACT_MESSAGES: Record<ContactLeakCode, string> = {
  contact_phone: '包含电话号码：小红书禁止直接留电话，请改用留资卡/名片',
  contact_wechat: '包含微信号或引导加微信：属于站外引流，请改用留资卡/名片',
  contact_qq: '包含QQ号或引导加QQ：属于站外引流',
  contact_email: '包含邮箱地址：属于站外联系方式',
  contact_link: '包含外部链接/网址：平台不允许站外链接',
  off_platform_solicitation: '包含站外引流表述（如“加我”“扫码”“主页联系方式”“公众号”）',
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalization with an index map back to the original text
// ─────────────────────────────────────────────────────────────────────────────

interface MappedText {
  source: string;
  /** NFKC + lower-cased text (whitespace preserved) */
  text: string;
  /** for each UTF-16 unit of `text`: [start, end) offsets in `source` */
  starts: number[];
  ends: number[];
}

function mapText(source: string): MappedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const cp of source) {
    const mapped = cp.normalize('NFKC').toLowerCase();
    for (let k = 0; k < mapped.length; k++) {
      starts.push(offset);
      ends.push(offset + cp.length);
    }
    text += mapped;
    offset += cp.length;
  }
  return { source, text, starts, ends };
}

function quoteOf(m: MappedText, start: number, end: number): string {
  if (end <= start) return '';
  return m.source.slice(m.starts[start], m.ends[end - 1]);
}

interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const contains = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end;

function spans(re: RegExp, text: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Trim whitespace (and trailing sentence punctuation for links) from a span. */
function tighten(text: string, span: Span, trailingPunct = false): Span {
  let { start, end } = span;
  while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && (/\s/u.test(text[end - 1]) || (trailingPunct && /[,.!?;:)\]'"]/u.test(text[end - 1])))) end--;
  return { start, end };
}

/** Chinese numerals → ASCII digits (1:1 UTF-16 units, so offsets stay aligned). */
const CN_DIGITS: Record<string, string> = {
  零: '0', 〇: '0', 一: '1', 幺: '1', 壹: '1', 二: '2', 两: '2', 贰: '2', 三: '3', 叁: '3', 四: '4',
  肆: '4', 五: '5', 伍: '5', 六: '6', 陆: '6', 七: '7', 柒: '7', 八: '8', 捌: '8', 九: '9', 玖: '9',
};
const digitize = (text: string) => text.replace(/[零〇一幺壹二两贰三叁四肆五伍六陆七柒八捌九玖]/gu, (c) => CN_DIGITS[c] ?? c);

// ─────────────────────────────────────────────────────────────────────────────
// Contact-information / off-platform patterns (applied to the normalized text)
// ─────────────────────────────────────────────────────────────────────────────

const R = String.raw;

const EMOJI_UNIT = R`(?:\p{Extended_Pictographic}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])`;

const PHONE_PATTERNS = [
  // mainland mobile, optional +86, tolerant of spaces / dashes / dots / slashes / emoji between digits
  R`(?<![0-9])(?:\+?86[\s\-]{0,2})?1[3-9](?:(?:[\s\-_.·/|]|${EMOJI_UNIT}){0,2}[0-9]){9}(?![0-9])`,
  // landline with area code, e.g. 0571-88886666 · (0571)8888 6666 · 010-1234-5678
  R`(?<![0-9])\(?0[1-9][0-9]{1,2}\)?[\s\-]{0,2}[0-9]{3,4}[\s\-]?[0-9]{4}(?![0-9])`,
  // 400 / 800 service numbers
  R`(?<![0-9])[48]00[\s\-]{0,2}[0-9]{3}[\s\-]{0,2}[0-9]{4}(?![0-9])`,
].map((p) => new RegExp(p, 'gu'));

const WX_LATIN = R`(?<![a-z0-9])(?:v信|vx|wx|weixin|wechat)(?![a-z])`;
const WX_KW = R`(?:[微威薇徽](?:[\s*·_\-]|${EMOJI_UNIT}){0,2}信|企业微信|企微|绿泡泡|${WX_LATIN})`;
const V_TOKEN = R`(?:${WX_KW}|(?<![a-z0-9])v(?![a-z0-9]))`;
/** separators people put between a contact keyword and the id, incl. brackets: 微信（abc123）/ 微信【abc123】 */
const SEP = R`(?:[\s:=~>→\-_·.,、。|/\\*#()\[\]【】「」『』<《》"'“”‘’]|号码|号|是|id|${EMOJI_UNIT}){0,6}`;
const WX_ID = R`(?:[a-z][a-z0-9_\-]{5,19}|[0-9]{6,12})`;
const ID_END = R`(?![a-z0-9_\-])`;
/** optional closing bracket after an id, so the quote covers "（abc12345）" completely */
const ID_CLOSE = R`[)\]】」』>》"'”’]?`;
const BENIGN_WX_USE = R`(?!支付|付款|转账|红包|朋友圈|公众号|小程序|视频号|型|形|字领|字)`;
/** "+" only counts as "加" when it is not part of a spec like "2.0T+V型" */
const PLUS = R`(?<![a-z0-9])\+`;
const QQ_KW = R`(?:(?<![a-z0-9])qq(?![a-z])|扣扣|企鹅号)`;
const LINK_TLDS =
  'com|cn|net|org|cc|top|xyz|io|me|vip|shop|link|info|club|site|online|tv|co|app|ly|hk|tw|store|biz|tech|ai|fun|ink|mobi|asia|group|today|space|website|news|video|market|email';
const CLAUSE_BOUNDARY_RE = /[,，。.!！?？;；\n]/u;

interface LeakPattern {
  code: ContactLeakCode;
  re: RegExp;
  /** weak matches are dropped when fully contained in an accepted match */
  weak: boolean;
  /** run on the digitized text (Chinese numerals → digits) */
  digits?: boolean;
  /** strip trailing punctuation (links) */
  link?: boolean;
  /**
   * drop the match when its clause (text between sentence punctuation) points at the compliant channel
   * (e.g. 留资卡 / 名片) and does not negate it ("不用留资卡，直接留个电话" stays flagged)
   */
  exemptClause?: { re: RegExp; negation: RegExp };
}

const LEAK_PATTERNS: LeakPattern[] = [
  ...PHONE_PATTERNS.map((re) => ({ code: 'contact_phone' as const, re, weak: false, digits: true })),
  { code: 'contact_wechat', re: new RegExp(WX_KW + SEP + WX_ID + ID_END + ID_CLOSE, 'gu'), weak: false },
  {
    code: 'contact_wechat',
    re: new RegExp(R`(?<![a-z0-9])v\s{0,2}(?:[:=]|(?:${EMOJI_UNIT}|[*·])+\s{0,2}[:=]?)\s{0,2}` + WX_ID + ID_END + ID_CLOSE, 'gu'),
    weak: false,
  },
  {
    code: 'contact_wechat',
    re: new RegExp(R`(?:互加|交换|添加|加|➕|${PLUS}|留|发|给|私|要|换|求|扫)(?:个|一下|下|我|你|您|的|一个){0,3}${V_TOKEN}${BENIGN_WX_USE}`, 'gu'),
    weak: true,
  },
  {
    // slang "加微" / "➕薇" (short for 加微信), optionally followed by the id
    code: 'contact_wechat',
    re: new RegExp(
      R`(?<![增参追更附叠施强])(?:加|➕|${PLUS})(?:个|一下|下|我|你|您|的){0,3}[微薇](?:${SEP}${WX_ID}${ID_END}${ID_CLOSE}|(?=$|[\s\p{P}\p{S}]|${EMOJI_UNIT}|联系|详聊|私聊|沟通|聊|咨询))`,
      'gu',
    ),
    weak: true,
  },
  {
    code: 'contact_wechat',
    re: new RegExp(
      R`${V_TOKEN}(?:号码|号)?\s{0,2}(?:联系|详聊|私聊|沟通|聊|私我|私|发你|发给你|加我|找我|咨询|同号|是多少|多少|见主页|在主页|扫码(?!支付|付款|付|缴费|买单|点餐)|二维码)`,
      'gu',
    ),
    weak: true,
  },
  { code: 'contact_wechat', re: new RegExp(R`有(?:没有)?${WX_KW}(?:号)?吗`, 'gu'), weak: true },
  { code: 'contact_qq', re: new RegExp(R`${QQ_KW}(?:号码|号|群)?${SEP}[0-9]{5,11}(?![0-9])${ID_CLOSE}`, 'gu'), weak: false },
  {
    code: 'contact_qq',
    re: new RegExp(R`(?:添加|加|留|发|私|给)(?:个|一下|下|我|你|您|的){0,3}${QQ_KW}`, 'gu'),
    weak: true,
  },
  { code: 'contact_qq', re: new RegExp(R`${QQ_KW}(?:号)?\s{0,2}(?:联系|聊|私|找我|多少)`, 'gu'), weak: true },
  {
    code: 'contact_email',
    re: /[a-z0-9][a-z0-9._%+\-]*@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,10}(?![a-z])/gu,
    weak: false,
  },
  {
    code: 'contact_link',
    re: /(?:https?|ftp):\/\/[^\s\p{Script=Han}、【】「」《》<>"']+/gu,
    weak: false,
    link: true,
  },
  {
    code: 'contact_link',
    re: /(?<![a-z0-9.\-])www\.[a-z0-9\-]+(?:\.[a-z0-9\-]+)+(?:[/?#][^\s\p{Script=Han}、【】「」《》<>"']*)?/gu,
    weak: false,
    link: true,
  },
  {
    code: 'contact_link',
    re: new RegExp(
      R`(?<![a-z0-9@.\-/])(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:${LINK_TLDS})(?![a-z0-9\-])(?:[/?#][^\s\p{Script=Han}、【】「」《》<>"']*)?`,
      'gu',
    ),
    weak: true,
    link: true,
  },
  {
    // obfuscated dots: "bmwhz点com" / "bmwhz。cn" / "bmwhz(.)com" / "bmwhz dot com"
    code: 'contact_link',
    re: /(?<![a-z0-9.\-])(?=[a-z0-9\-]*[a-z])[a-z0-9][a-z0-9\-]{1,62}\s?(?:点|。|\(\.\)|\[\.\]|dot)\s?(?:com|cn|net|org|top|vip|xyz|cc)(?![a-z0-9\-])/gu,
    weak: false,
  },
  { code: 'off_platform_solicitation', re: /(?<![参增追更附叠])加我(?!们)/gu, weak: true },
  { code: 'off_platform_solicitation', re: /扫码(?!支付|付款|付|缴费|买单|点餐)|扫一扫|二维码/gu, weak: true },
  {
    code: 'off_platform_solicitation',
    re: /(?:主页(?:简介|介绍|置顶|签名)?|个人简介|简介|个签|签名栏?|置顶(?:笔记|评论)?)(?:里|上|中)?(?:有|见|留|看|里|上)?的?(?:联系方式|电话|手机号?|微信|vx|wx|v(?![a-z0-9])|qq|扣扣)/gu,
    weak: true,
  },
  {
    code: 'off_platform_solicitation',
    re: /(?:联系方式|电话|手机号?|微信|vx|wx|(?<![a-z0-9])v|qq)(?:在|见|看)(?:我的?)?(?:主页|简介|个签|签名|置顶)/gu,
    weak: true,
  },
  {
    code: 'off_platform_solicitation',
    re: /(?:关注|搜一搜|搜索|搜|添加|加|私信)(?:一下|下)?(?:我们的?|我的?)?(?:微信)?公众号|公众号\s{0,2}:|同名(?:公众号|视频号|抖音号?|微博|快手号?|微信号?|b站)|私域|引流/gu,
    weak: true,
  },
  {
    code: 'off_platform_solicitation',
    re: /(?:留|发)(?:个|一下|下)?(?:我|你|您)?的?(?:电话|手机号?|联系方式|号码)/gu,
    weak: true,
    exemptClause: { re: /留资卡|名片/u, negation: /不用|不要|不需要|无需|别用|不走|绕过|跳过|不填|不点|不方便|麻烦/u },
  },
];

/** The clause (between sentence punctuation) that contains `span`. */
function clauseOf(text: string, span: Span): string {
  let start = span.start;
  while (start > 0 && !CLAUSE_BOUNDARY_RE.test(text[start - 1])) start--;
  let end = span.end;
  while (end < text.length && !CLAUSE_BOUNDARY_RE.test(text[end])) end++;
  return text.slice(start, end);
}

interface LeakMatch extends Span {
  code: ContactLeakCode;
  weak: boolean;
}

function scanContactLeaks(m: MappedText): LeakMatch[] {
  const digitized = digitize(m.text);
  const candidates: LeakMatch[] = [];
  for (const p of LEAK_PATTERNS) {
    const haystack = p.digits ? digitized : m.text;
    for (const raw of spans(p.re, haystack)) {
      const span = tighten(m.text, raw, p.link === true);
      if (span.end <= span.start) continue;
      if (p.exemptClause) {
        const clause = clauseOf(m.text, span);
        if (p.exemptClause.re.test(clause) && !p.exemptClause.negation.test(clause)) continue;
      }
      candidates.push({ ...span, code: p.code, weak: p.weak });
    }
  }
  // strong before weak, longer before shorter → the most informative match wins
  candidates.sort((a, b) => Number(a.weak) - Number(b.weak) || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: LeakMatch[] = [];
  for (const c of candidates) {
    const sameCode = accepted.find((a) => a.code === c.code && overlaps(a, c));
    if (sameCode) {
      // e.g. "加V" + "V详聊" → one issue quoting "加V详聊"
      sameCode.start = Math.min(sameCode.start, c.start);
      sameCode.end = Math.max(sameCode.end, c.end);
      continue;
    }
    if (c.weak && accepted.some((a) => contains(a, c))) continue;
    accepted.push(c);
  }
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Detect contact information and off-platform solicitation: mainland mobile (incl. spaced / dashed /
 * full-width / Chinese-numeral digits) and landline numbers, WeChat ids and "加微信" style
 * solicitations (微信 / 薇信 / 威信 / v信 / vx / wx / 加V / ➕V / "V:" + id), QQ numbers, e-mail,
 * URLs / domains and 引流 phrases (加我 / 扫码 / 主页联系方式 / 公众号 / 私域).
 * Benign mentions such as "支持微信支付" and automotive trims/prices ("325Li", "35.39万", "36期") are not flagged.
 */
export function detectContactInfoLeak(text: string): RuleIssue[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const m = mapText(text);
  return scanContactLeaks(m).map((x) => ({ code: x.code, message: CONTACT_MESSAGES[x.code], quote: quoteOf(m, x.start, x.end) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform rules
// ─────────────────────────────────────────────────────────────────────────────

/** Factual finance phrasing ("最低首付2成", "首付 最低 2成") must not trip "最低"-style superlative checks. */
const FINANCE_EXEMPT_RE = /最\s*低\s*(?:首\s*付|月\s*供)|(?:首\s*付(?:\s*比\s*例)?|月\s*供)\s*最\s*低/gu;

const PICTOGRAPH_RE = /\p{Extended_Pictographic}/gu;
const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;
const NON_EMOJI_PICTOGRAPHS = new Set(['©', '®', '™', '‼', '⁉', '〰', '〽']);
const XHS_EMOJI_CODE_RE = /\[[\p{Script=Han}]{1,5}r\]/gu;
const GRAPHEMES = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const PUNCT_SPAM_RE = /[!?]{4,}|~{4,}/gu;

const DM_BOILERPLATE_RES: RegExp[] = [
  /回复?\s{0,2}(?:td|t|n|0)\s{0,2}(?:退订|拒收)/gu,
  /退订\s{0,2}(?:请)?\s{0,2}回(?:复)?\s{0,2}(?:td|t|n)?/gu,
  /拒收请回复/gu,
  /^\s*【[^】]{1,20}】|【[^】]{1,20}】\s*$/gu,
  /尊敬的(?:客户|用户|会员|车主|先生|女士)/gu,
  /亲爱的(?:用户|会员|客户)/gu,
  /(?:点击|戳)(?:下方|以下)?链接/gu,
];

const DM_ANY_LINK_RE = /[a-z][a-z0-9+.\-]*:\/\/[^\s\p{Script=Han}]+|(?<![a-z0-9@.\-])(?:[a-z0-9\-]+\.)+[a-z]{2,12}\/[^\s\p{Script=Han}]*|xhslink/gu;

/**
 * Emoji as rendered glyphs: a flag (regional-indicator pair), a ZWJ family, a skin-toned hand or a keycap
 * counts once; plus Xiaohongshu inline codes like "[赞R]". Text symbols such as ©/®/™ are not emoji.
 */
export function countEmoji(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let n = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (segment.includes('\u20E3') || REGIONAL_INDICATOR_RE.test(segment)) {
      n++;
      continue;
    }
    const pictographs = [...segment.matchAll(PICTOGRAPH_RE)].map((x) => x[0]);
    if (pictographs.length === 0) continue;
    if (pictographs.every((p) => NON_EMOJI_PICTOGRAPHS.has(p)) && !segment.includes('\uFE0F')) continue;
    n++;
  }
  n += [...normalizeText(text).matchAll(XHS_EMOJI_CODE_RE)].length;
  return n;
}

const REGEX_SYNTAX_RE = /[\^$\\.*+?()[\]{}|/]/g;

/** Whitespace-tolerant, NFKC + case-insensitive matcher for a phrase ("No.1" also matches "NO. 1"). */
function phraseRegex(phrase: string): RegExp | null {
  const chars = [...phrase.normalize('NFKC').toLowerCase()].filter((c) => !/\s/u.test(c));
  if (chars.length === 0) return null;
  return new RegExp(chars.map((c) => c.replace(REGEX_SYNTAX_RE, '\\$&')).join(R`\s*`), 'gu');
}

/**
 * First occurrence of `phrase` that is not inside a finance exemption span, not contained in one of
 * `containedIn` and not overlapping one of `overlapping`.
 */
function findPhrase(
  m: MappedText,
  phrase: string,
  exempt: Span[],
  containedIn: Span[] = [],
  overlapping: Span[] = [],
): Span | null {
  const needle = phrase.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const re = phraseRegex(phrase);
  if (!needle || !re) return null;
  const allowExemption = !needle.includes('首付') && !needle.includes('月供');
  let from = 0;
  while (from <= m.text.length) {
    re.lastIndex = from;
    const match = re.exec(m.text);
    if (!match) return null;
    const span = { start: match.index, end: match.index + match[0].length };
    from = match.index + 1;
    if (allowExemption && exempt.some((e) => contains(e, span))) continue;
    if (containedIn.some((t) => contains(t, span))) continue;
    if (overlapping.some((t) => overlaps(t, span))) continue;
    return span;
  }
  return null;
}

/**
 * Check a customer-facing text against platform rules. Issue codes:
 * `empty_text`, contact-leak codes (see CONTACT_LEAK_CODES), `prohibited_claim`, `ad_law_absolute_term`,
 * `too_long`, `excessive_emoji`, `punctuation_spam`, and for channel `dm` also `marketing_boilerplate`
 * and `link_in_dm` (any link, including on-platform short links).
 */
export function checkPlatformRules(text: string, opts: PlatformRuleOptions): { passed: boolean; issues: RuleIssue[] } {
  if (typeof text !== 'string') throw new ValidationError('text', 'expected string');
  if (!opts || typeof opts.max_length !== 'number' || !Number.isFinite(opts.max_length) || opts.max_length <= 0)
    throw new ValidationError('max_length', 'must be a positive number');
  if (!(RULE_CHANNELS as readonly string[]).includes(opts.channel))
    throw new ValidationError('channel', `expected one of ${RULE_CHANNELS.join('|')}`);

  const m = mapText(text);
  const issues: RuleIssue[] = [];

  if (meaningfulChars(text).length === 0) issues.push({ code: 'empty_text', message: '内容为空或没有有效文字' });

  const leaks = scanContactLeaks(m);
  for (const x of leaks) issues.push({ code: x.code, message: CONTACT_MESSAGES[x.code], quote: quoteOf(m, x.start, x.end) });

  const exempt = spans(FINANCE_EXEMPT_RE, m.text);
  const claimSpans: Span[] = [];
  const seenPhrases = new Set<string>();
  for (const p of opts.prohibited ?? []) {
    const key = (typeof p?.phrase === 'string' ? p.phrase : '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    if (!key || seenPhrases.has(key)) continue;
    seenPhrases.add(key);
    const span = findPhrase(m, p.phrase, exempt);
    if (!span) continue;
    claimSpans.push(span);
    const reason = (p.reason ?? '').trim();
    issues.push({
      code: 'prohibited_claim',
      message: reason ? `包含禁用表述「${p.phrase}」：${reason}` : `包含禁用表述「${p.phrase}」`,
      quote: quoteOf(m, span.start, span.end),
    });
  }

  const terms = [...AD_LAW_ABSOLUTE_TERMS].sort((a, b) => b.length - a.length);
  const adSpans: Span[] = [];
  for (const term of terms) {
    // skip when already reported as a dealer-prohibited phrase covering it, or overlapping a longer term
    const span = findPhrase(m, term, exempt, claimSpans, adSpans);
    if (!span) continue;
    adSpans.push(span);
    issues.push({
      code: 'ad_law_absolute_term',
      message: `包含广告法禁止的绝对化用语「${term}」`,
      quote: quoteOf(m, span.start, span.end),
    });
  }

  const length = [...text].length;
  if (length > opts.max_length)
    issues.push({ code: 'too_long', message: `内容${length}字，超过上限${opts.max_length}字` });

  const emoji = countEmoji(text);
  if (emoji > MAX_EMOJI)
    issues.push({ code: 'excessive_emoji', message: `表情符号过多（${emoji}个，上限${MAX_EMOJI}个），易被判定为营销内容` });

  const punct = spans(PUNCT_SPAM_RE, m.text)[0];
  if (punct)
    issues.push({ code: 'punctuation_spam', message: '连续重复标点过多，易被判定为营销内容', quote: quoteOf(m, punct.start, punct.end) });

  if (opts.channel === 'dm') {
    const boiler: Span[] = [];
    for (const re of DM_BOILERPLATE_RES) {
      for (const raw of spans(re, m.text)) {
        const span = tighten(m.text, raw);
        if (span.end <= span.start || boiler.some((b) => overlaps(b, span))) continue;
        boiler.push(span);
        issues.push({
          code: 'marketing_boilerplate',
          message: '包含群发营销模板用语（如“回复TD退订”“尊敬的客户”），私信必须一对一个性化',
          quote: quoteOf(m, span.start, span.end),
        });
      }
    }
    const linkSpans = leaks.filter((x) => x.code === 'contact_link');
    for (const raw of spans(DM_ANY_LINK_RE, m.text)) {
      const span = tighten(m.text, raw, true);
      if (span.end <= span.start || linkSpans.some((l) => overlaps(l, span))) continue;
      linkSpans.push({ ...span, code: 'contact_link', weak: false });
      issues.push({ code: 'link_in_dm', message: '私信中不允许包含任何链接', quote: quoteOf(m, span.start, span.end) });
    }
  }

  return { passed: issues.length === 0, issues };
}

/**
 * Near-duplicate detection (mass-template guard) via bigram Jaccard similarity on normalized text.
 * Texts without meaningful characters only match when they are identical after normalization.
 */
export function isNearDuplicate(
  text: string,
  others: readonly string[],
  threshold = 0.85,
): { duplicate: boolean; max_similarity: number } {
  const t = typeof threshold === 'number' && Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.85;
  const base = typeof text === 'string' ? text : '';
  const baseMeaningful = meaningfulChars(base).length > 0;
  let max = 0;
  for (const other of others ?? []) {
    if (typeof other !== 'string') continue;
    let sim: number;
    if (baseMeaningful && meaningfulChars(other).length > 0) sim = textSimilarity(base, other);
    else {
      const a = normalizeText(base);
      sim = a !== '' && a === normalizeText(other) ? 1 : 0;
    }
    if (sim > max) max = sim;
  }
  return { duplicate: max > 0 && max >= t, max_similarity: round(max, 4) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const complianceInput = v.object({
  text: v.string(),
  channel: v.literal(RULE_CHANNELS),
  max_length: v.optional(v.number({ int: true, min: 1 })),
  prohibited: v.withDefault(
    v.array(v.object({ phrase: v.string({ min: 1 }), reason: v.withDefault(v.string(), '') })),
    [],
  ),
  compare_with: v.withDefault(v.array(v.string()), []),
  duplicate_threshold: v.optional(v.number({ min: 0, max: 1 })),
});

export interface ComplianceSkillOutput {
  passed: boolean;
  issues: RuleIssue[];
  max_length: number;
  duplicate: { duplicate: boolean; max_similarity: number };
}

export const skill = defineSkill({
  name: 'compliance',
  category: 'operations',
  agent: 'content-review-agent',
  description:
    '平台合规检查：联系方式/站外引流（电话、微信、QQ、链接）、经销商禁用表述、广告法绝对化用语、长度、表情/标点刷屏、私信群发模板与近似重复。',
  input: complianceInput,
  run(_ctx: AppContext, input): ComplianceSkillOutput {
    const maxLength = input.max_length ?? DEFAULT_MAX_LENGTH[input.channel];
    const rules = checkPlatformRules(input.text, {
      prohibited: input.prohibited,
      max_length: maxLength,
      channel: input.channel,
    });
    const duplicate = isNearDuplicate(input.text, input.compare_with, input.duplicate_threshold ?? 0.85);
    const issues = [...rules.issues];
    if (duplicate.duplicate)
      issues.push({
        code: 'near_duplicate',
        message: `与已有内容高度相似（相似度${Math.round(duplicate.max_similarity * 100)}%），疑似群发模板`,
      });
    return { passed: issues.length === 0, issues, max_length: maxLength, duplicate };
  },
});
