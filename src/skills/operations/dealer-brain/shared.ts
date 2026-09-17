import { createHash } from 'node:crypto';
import { formatCny, normalizeText } from '../../../core/text.ts';
import { DEFAULT_TZ, addDaysToKey, localDateKey, zonedTimeToUtc } from '../../../core/time.ts';
import type { Dealer, DealerSettings } from '../../../core/types.ts';

/** Dealer defaults applied when a dealer seed (or a stored row) omits a setting. Frozen: consumers copy, never mutate. */
export const DEFAULT_DEALER_SETTINGS: DealerSettings = Object.freeze({
  outreach_approval_policy: 'REVIEW_REQUIRED',
  publish_approval_policy: 'REVIEW_REQUIRED',
  daily_outreach_limit: 20,
  min_outreach_interval_minutes: 3,
  max_unanswered_touches: 2,
  follow_up_after_days: 2,
  daily_publish_limit: 2,
  max_ai_conversation_turns: 6,
  auto_send_min_score: 90,
  timezone: DEFAULT_TZ,
});

/** Setting keys accepted in dealer seeds (anything else is a typo and rejected). */
export const DEALER_SETTING_KEYS = Object.keys(DEFAULT_DEALER_SETTINGS) as (keyof DealerSettings)[];

/**
 * CNY for customer-facing text: `formatCny` when it is exact ('35.39万', '9万', '8000元'), otherwise the
 * full amount in 元 so an amount like 12345 is never silently rounded to '1.23万'.
 */
export function exactCny(amount: number): string {
  const formatted = formatCny(amount);
  if (!formatted.endsWith('万')) return formatted;
  return Math.round(parseFloat(formatted) * 10_000) === amount ? formatted : `${amount}元`;
}

export function mergeDealerSettings(partial: Partial<DealerSettings> | null | undefined): DealerSettings {
  const out: DealerSettings = { ...DEFAULT_DEALER_SETTINGS };
  if (partial) {
    for (const [k, val] of Object.entries(partial)) {
      if (val !== undefined && val !== null) (out as unknown as Record<string, unknown>)[k] = val;
    }
  }
  return out;
}

export function dealerTz(dealer: Pick<Dealer, 'settings'>): string {
  return dealer.settings?.timezone || DEFAULT_TZ;
}

/** Deterministic id derived from natural keys: `<prefix>_<sha1(groupKey|key)[0..16]>`. */
export function stableId(prefix: string, groupKey: string, key: string): string {
  return `${prefix}_${createHash('sha1').update(`${groupKey}|${key}`).digest('hex').slice(0, 16)}`;
}

/** JSON serialization with sorted object keys (order-insensitive equality for JSON columns). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Matching key: NFKC, lower-case, without whitespace and joiner punctuation ('i3 35L' → 'i335l'). */
export function matchKey(input: string | null | undefined): string {
  if (!input) return '';
  return normalizeText(input).replace(/[\s\-_·•.／/]+/g, '');
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_OR_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2})(:(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 'YYYY-MM-DD' (a real calendar day) or a full ISO-8601 timestamp with a valid date, time and offset. */
export function isValidDateValue(value: string): boolean {
  const m = DATE_OR_ISO_RE.exec(value);
  if (!m) return false;
  if (!isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  if (m[4]) {
    const hour = Number(m[5]);
    const minute = Number(m[6]);
    const second = m[8] ? Number(m[8]) : 0;
    if (hour > 23 || minute > 59 || second > 59) return false;
    if (Number.isNaN(Date.parse(value))) return false;
  }
  return true;
}

/** Instant (ms) at which a validity window opens. Date-only values open at local 00:00 in `tz`. */
export function validityStartMs(value: string, tz: string): number {
  const m = DATE_ONLY_RE.exec(value);
  if (m) return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, tz).getTime();
  return new Date(value).getTime();
}

/** Instant (ms, inclusive) at which a validity window closes. Date-only values close at the end of that local day. */
export function validityEndMs(value: string, tz: string): number {
  const m = DATE_ONLY_RE.exec(value);
  if (m) {
    const next = addDaysToKey(value, 1);
    const [y, mo, d] = next.split('-').map(Number);
    return zonedTimeToUtc(y, mo, d, 0, 0, tz).getTime() - 1;
  }
  return new Date(value).getTime();
}

/** Validity check in dealer time. Corrupt (unparseable) bounds fail closed: the row is treated as not valid. */
export function isValidAt(from: string | null, until: string | null, now: Date, tz: string): boolean {
  const t = now.getTime();
  if (from) {
    const start = isValidDateValue(from) ? validityStartMs(from, tz) : Number.NaN;
    if (Number.isNaN(start) || start > t) return false;
  }
  if (until) {
    const end = isValidDateValue(until) ? validityEndMs(until, tz) : Number.NaN;
    if (Number.isNaN(end) || end < t) return false;
  }
  return true;
}

/** Local calendar date ('YYYY-MM-DD') of a date-only or ISO value. */
export function localDateOf(value: string, tz: string): string {
  if (DATE_ONLY_RE.test(value)) return value;
  return localDateKey(new Date(value), tz);
}

/** '2026-09-30' → '9月30日' */
export function formatMonthDay(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m}月${d}日`;
}

const COLOR_SYNONYMS: Record<string, string> = {
  white: '白',
  black: '黑',
  red: '红',
  grey: '灰',
  gray: '灰',
  blue: '蓝',
  brown: '棕',
  silver: '银',
  green: '绿',
  咖: '棕',
  咖啡: '棕',
};

/** Single-character colour words recognised in free text (e.g. '白外红内', '灰色在途'). */
export const COLOR_CHARS = '白黑红灰蓝棕银绿金紫橙黄米咖青粉';

/** Canonical single-character colour for an English colour name, if any. */
export function colorSynonym(input: string): string | undefined {
  return COLOR_SYNONYMS[normalizeText(input).replace(/\s+/g, '')];
}

function colorCore(input: string): string {
  let s = normalizeText(input).replace(/\s+/g, '');
  s = s.replace(/(外观|内饰|车身|颜色|外|内|色)+$/u, '');
  const syn = COLOR_SYNONYMS[s];
  return syn ?? s;
}

/**
 * Tolerant colour matching: '白' matches '白', '白色', '矿石白'; '红' matches '珊瑚红'.
 * A query matches when its core colour word is contained in the stored colour (or vice versa).
 */
export function colorMatches(query: string | null | undefined, stored: string): boolean {
  if (!query) return true;
  const q = colorCore(query);
  if (!q) return true;
  const s = colorCore(stored);
  if (!s) return false;
  return s.includes(q) || q.includes(s);
}

/** Display label for a colour pair: '白外红内' for single-character colours, else '矿石白外观、珊瑚红内饰'. */
export function colorPairLabel(exterior: string, interior: string): string {
  const e = exterior.replace(/色$/u, '');
  const i = interior.replace(/色$/u, '');
  if ([...e].length === 1 && [...i].length === 1) return `${e}外${i}内`;
  return `${e}外观、${i}内饰`;
}
