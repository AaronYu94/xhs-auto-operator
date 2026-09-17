/** Chinese-aware text utilities used by NLU, deduplication and content similarity. */

/** NFKC (full-width → half-width), lower-case Latin, collapse whitespace. */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/** Xiaohongshu inline emoji codes look like [笑哭R] / [赞R] */
const XHS_EMOJI_CODE_RE = /\[[\p{Script=Han}A-Za-z]{1,6}R?\]/gu;
const PUNCT_RE = /[\p{P}\p{S}\s]/gu;

export function stripEmoji(input: string): string {
  return input.replace(XHS_EMOJI_CODE_RE, '').replace(EMOJI_RE, '');
}

/** Only CJK ideographs, letters and digits remain. */
export function meaningfulChars(input: string): string {
  return stripEmoji(normalizeText(input)).replace(PUNCT_RE, '');
}

export function meaningfulLength(input: string): number {
  return [...meaningfulChars(input)].length;
}

export function charNgrams(input: string, n = 2): Set<string> {
  const chars = [...meaningfulChars(input)];
  const out = new Set<string>();
  if (chars.length === 0) return out;
  if (chars.length < n) {
    out.add(chars.join(''));
    return out;
  }
  for (let i = 0; i <= chars.length - n; i++) out.add(chars.slice(i, i + n).join(''));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Bigram Jaccard similarity on normalized text, 0..1. */
export function textSimilarity(a: string, b: string): number {
  return jaccard(charNgrams(a, 2), charNgrams(b, 2));
}

/** Returns every word from `words` that occurs in `text` (normalized, case-insensitive). */
export function findAll(text: string, words: readonly string[]): string[] {
  const t = normalizeText(text);
  const hits: string[] = [];
  for (const w of words) if (w && t.includes(normalizeText(w))) hits.push(w);
  return hits;
}

export function truncate(input: string, max: number): string {
  const chars = [...input];
  return chars.length <= max ? input : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Format CNY: 259900 → '25.99万' ; 8000 → '8000元' */
export function formatCny(amount: number): string {
  if (Math.abs(amount) >= 10_000) {
    const wan = amount / 10_000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}万`;
  }
  return `${amount}元`;
}
