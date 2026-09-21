/**
 * Measuring how one account writes, from what it has actually published.
 *
 * Pure functions, no context, no LLM: counting is what makes the profile defensible. Everything is median- or
 * share-based on purpose — one unusually long note, one reposted press release or one all-emoji teaser must not move
 * the profile, and a mean would let it. A habit only becomes a rule when enough of the account's own notes show it
 * (`RULE_SUPPORT`), and every rule carries the measurement that produced it.
 *
 * What is NOT here: any judgement about what good writing is. The account already decided that.
 */
import { charNgrams, jaccard, normalizeText } from '../../../core/text.ts';
import type { VoiceExample, VoiceMetrics, VoiceRule, VoiceVocabulary } from '../../../core/types.ts';

export interface VoiceSample {
  platform_note_id: string;
  title: string;
  content: string;
  tags: string[];
  published_at: string | null;
}

/** A habit must show up in at least this share of the account's notes before it is written down as a rule. */
export const RULE_SUPPORT = 0.4;
/** …and the opposite: something it demonstrably never does. */
export const AVOID_SUPPORT = 0.1;
/** Below this, the sample is too thin for a profile: we say so instead of inventing a voice. */
export const MIN_SAMPLES = 3;
/** Notes shorter than this carry no style signal (a bare link, a one-word repost). */
const MIN_BODY_CHARS = 20;
const EXAMPLE_EXCERPT_CHARS = 220;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const SENTENCE_SPLIT_RE = /[。！!？?～~\n]+/u;
const CTA_RE = /私信|评论区|留言|扣1|扣个|蹲一个|到店|预约|试驾|咨询|戳我|找我|联系我|看车|来店|点赞|收藏|关注我/u;
const LIST_RE = /(?:^|\n)\s*(?:[1-9１-９][.、)）]|[①-⑩]|[-•·✅✔️🔹▪️]|\p{Extended_Pictographic}\s*[^\n]{0,8}[:：])/mu;
const SPEC_NUMBER_RE = /\d+(?:\.\d+)?\s*(?:万|元|公里|km|度|kWh|马力|匹|秒|座|期|%|成|台|L)/iu;
const FIRST_PERSON_RE = /我们|我|咱/u;
const FORMAL_YOU_RE = /您/u;
const CASUAL_YOU_RE = /你/u;

const chars = (s: string): number => [...s].length;
const clip = (s: string, n: number): string => (chars(s) > n ? `${[...s].slice(0, n).join('')}…` : s);

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  return Math.round(value * 100) / 100;
}
const median = (values: readonly number[]): number => quantile(values, 0.5);
const share = (values: readonly boolean[]): number => (values.length === 0 ? 0 : Math.round((values.filter(Boolean).length / values.length) * 100) / 100);

export const sentencesOf = (text: string): string[] =>
  text
    .split(SENTENCE_SPLIT_RE)
    .map((x) => x.trim())
    .filter((x) => chars(x) >= 2);

/** Notes with enough text to say anything about style. */
export function usableSamples(samples: readonly VoiceSample[]): VoiceSample[] {
  return samples.filter((s) => chars(s.content.trim()) >= MIN_BODY_CHARS);
}

export function measure(samples: readonly VoiceSample[]): VoiceMetrics {
  const used = usableSamples(samples);
  const bodies = used.map((s) => s.content);
  const titles = used.map((s) => s.title.trim()).filter(Boolean);
  const allSentences = bodies.flatMap(sentencesOf);
  const modelMentions = bodies.join('\n').match(/(?:小鹏\s?)?[A-Z]{1,2}\d{1,2}[A-Z]?\b|(?:小鹏\s?)?MONA\s?[A-Z]\d{2}/gu) ?? [];

  return {
    sample_count: used.length,
    title_chars_median: median(titles.map(chars)),
    title_chars_p25: quantile(titles.map(chars), 0.25),
    title_chars_p75: quantile(titles.map(chars), 0.75),
    title_emoji_share: share(titles.map((t) => EMOJI_RE.test(t) && ((EMOJI_RE.lastIndex = 0), true))),
    body_chars_median: median(bodies.map(chars)),
    sentence_chars_median: median(allSentences.map(chars)),
    short_sentence_share: share(allSentences.map((s) => chars(s) <= 12)),
    paragraph_count_median: median(bodies.map((b) => b.split(/\n+/).filter((x) => x.trim()).length)),
    emoji_per_100: median(bodies.map((b) => Math.round(((b.match(EMOJI_RE)?.length ?? 0) / Math.max(1, chars(b))) * 10000) / 100)),
    exclaim_share: share(bodies.map((b) => /[！!]/u.test(b))),
    question_share: share(bodies.map((b) => /[？?]/u.test(b))),
    tilde_share: share(bodies.map((b) => /[～~]/u.test(b))),
    tag_count_median: median(used.map((s) => s.tags.length)),
    cta_share: share(bodies.map((b) => CTA_RE.test(b))),
    list_share: share(bodies.map((b) => LIST_RE.test(b))),
    first_person_share: share(bodies.map((b) => FIRST_PERSON_RE.test(b))),
    you_formal_share: share(bodies.map((b) => FORMAL_YOU_RE.test(b))),
    you_casual_share: share(bodies.map((b) => CASUAL_YOU_RE.test(b))),
    spec_number_share: share(bodies.map((b) => SPEC_NUMBER_RE.test(b))),
    brand_prefix_share: modelMentions.length === 0 ? 0 : share(modelMentions.map((m) => /小鹏|宝马|BMW|奥迪|特斯拉/u.test(m))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary: the account's own words, verbatim
// ─────────────────────────────────────────────────────────────────────────────

function topCounted(items: readonly string[], limit: number, minCount = 2): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k);
}

/** Repeated 4–8 character runs the account uses across several notes — its own turns of phrase, not ours. */
function recurringPhrases(bodies: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    const seen = new Set<string>();
    for (const sentence of sentencesOf(body)) {
      const cs = [...sentence.replace(/\s+/g, '')];
      for (let n = 6; n >= 4; n--) {
        for (let i = 0; i + n <= cs.length; i++) {
          const gram = cs.slice(i, i + n).join('');
          if (!/^[一-鿿]+$/u.test(gram)) continue;
          seen.add(gram);
        }
      }
    }
    for (const gram of seen) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  const frequent = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const out: string[] = [];
  // Sliding windows over the same sentence produce near-identical grams ('年轻人第一台' / '轻人第一台电'); keep one.
  const overlaps = (a: string, b: string): boolean => {
    if (a.includes(b) || b.includes(a)) return true;
    for (let i = 0; i + 4 <= a.length; i++) if (b.includes(a.slice(i, i + 4))) return true;
    // the same window shifted by one or two characters: one ends where the other begins
    for (const [x, y] of [[a, b], [b, a]] as const) {
      for (let n = 3; n <= 5 && n < Math.min(x.length, y.length); n++) if (x.slice(-n) === y.slice(0, n)) return true;
    }
    return false;
  };
  for (const [gram] of frequent) {
    if (out.some((kept) => overlaps(kept, gram))) continue;
    out.push(gram);
    if (out.length >= limit) break;
  }
  return out;
}

export function vocabulary(samples: readonly VoiceSample[]): VoiceVocabulary {
  const used = usableSamples(samples);
  const bodies = used.map((s) => s.content);
  const openers = used.map((s) => sentencesOf(s.content)[0] ?? '').filter(Boolean).map((x) => clip(x, 24));
  const closers = used.map((s) => sentencesOf(s.content).at(-1) ?? '').filter(Boolean).map((x) => clip(x, 24));
  const ctas = bodies.flatMap((b) => sentencesOf(b).filter((x) => CTA_RE.test(x))).map((x) => clip(x, 28));
  const emojis = bodies.flatMap((b) => b.match(EMOJI_RE) ?? []);
  return {
    // openers/closers repeat rarely, so keep the most recent few verbatim rather than only repeated ones
    openers: [...new Set(openers)].slice(0, 5),
    closers: [...new Set(closers)].slice(0, 5),
    cta_phrases: [...new Set(ctas)].slice(0, 5),
    tags: topCounted(used.flatMap((s) => s.tags), 12, 2),
    phrases: recurringPhrases(bodies, 10),
    emojis: topCounted(emojis, 8, 2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules: what a writer must do to sound like this account
// ─────────────────────────────────────────────────────────────────────────────

const pct = (x: number): string => `${Math.round(x * 100)}%`;

export function deriveRules(m: VoiceMetrics, v: VoiceVocabulary): { rules: VoiceRule[]; avoid: string[] } {
  const rules: VoiceRule[] = [];
  const avoid: string[] = [];
  const add = (rule: string, basis: string) => rules.push({ rule, basis });

  if (m.title_chars_median > 0) {
    const lo = Math.max(6, Math.round(m.title_chars_p25));
    const hi = Math.max(lo + 2, Math.round(m.title_chars_p75));
    add(`标题写 ${lo}–${hi} 个字`, `历史标题中位数 ${m.title_chars_median} 字`);
  }
  if (m.title_emoji_share >= RULE_SUPPORT) add('标题里带 emoji', `${pct(m.title_emoji_share)} 的历史标题带 emoji`);
  else if (m.title_emoji_share <= AVOID_SUPPORT) avoid.push('标题不要加 emoji');

  if (m.body_chars_median > 0) add(`正文 ${Math.round(m.body_chars_median * 0.8)}–${Math.round(m.body_chars_median * 1.2)} 字`, `历史正文中位数 ${m.body_chars_median} 字`);
  if (m.paragraph_count_median >= 2) add(`分 ${Math.round(m.paragraph_count_median)} 段左右，段落之间空行`, `历史笔记中位数 ${m.paragraph_count_median} 段`);
  if (m.short_sentence_share >= 0.5) add('多用短句，一句话说一件事', `${pct(m.short_sentence_share)} 的句子不超过 12 字`);
  else if (m.sentence_chars_median >= 20) add('句子写得完整一些，不要切得太碎', `历史句子中位数 ${m.sentence_chars_median} 字`);

  if (m.list_share >= RULE_SUPPORT) add('正文用分点结构（1/2/3 或 emoji 起头）', `${pct(m.list_share)} 的笔记是分点写的`);
  if (m.emoji_per_100 >= 1) add(`正文按每 100 字 ${m.emoji_per_100} 个左右的密度用 emoji`, `历史正文 emoji 密度中位数 ${m.emoji_per_100}/100 字`);
  else if (m.emoji_per_100 === 0) avoid.push('正文不要用 emoji');
  if (v.emojis.length > 0) add(`emoji 用这几个：${v.emojis.slice(0, 5).join(' ')}`, '历史笔记里重复出现的 emoji');

  if (m.exclaim_share >= RULE_SUPPORT) add('语气可以带感叹号', `${pct(m.exclaim_share)} 的笔记用了感叹号`);
  else if (m.exclaim_share <= AVOID_SUPPORT) avoid.push('不要用感叹号');
  if (m.question_share >= RULE_SUPPORT) add('用提问带节奏（开头或分点里）', `${pct(m.question_share)} 的笔记有问句`);
  if (m.tilde_share >= RULE_SUPPORT) add('句尾可以用「～」软化语气', `${pct(m.tilde_share)} 的笔记用了～`);
  else if (m.tilde_share <= AVOID_SUPPORT) avoid.push('不要用「～」');

  if (m.you_formal_share >= RULE_SUPPORT && m.you_formal_share > m.you_casual_share) add('称呼客户用「您」', `${pct(m.you_formal_share)} 的笔记用「您」`);
  else if (m.you_casual_share >= RULE_SUPPORT) {
    add('称呼客户用「你」', `${pct(m.you_casual_share)} 的笔记用「你」`);
    if (m.you_formal_share <= AVOID_SUPPORT) avoid.push('不要用「您」，这个账号一直用「你」');
  }
  if (m.first_person_share >= RULE_SUPPORT) add('用第一人称讲（我/我们）', `${pct(m.first_person_share)} 的笔记是第一人称`);

  if (m.spec_number_share >= RULE_SUPPORT) add('讲车型要给具体参数和价格（数字只能来自车型库）', `${pct(m.spec_number_share)} 的笔记写了具体参数`);
  else if (m.spec_number_share <= AVOID_SUPPORT) avoid.push('不要堆参数，这个账号很少写具体数字');
  if (m.brand_prefix_share >= 0.6) add('车型写全称（带品牌）', `${pct(m.brand_prefix_share)} 的车型提法带品牌前缀`);

  if (m.cta_share >= RULE_SUPPORT) {
    const sample = v.cta_phrases[0];
    add(`结尾要有引导${sample ? `，像「${sample}」这样` : ''}`, `${pct(m.cta_share)} 的笔记结尾有引导`);
  } else if (m.cta_share <= AVOID_SUPPORT) avoid.push('结尾不要硬加引导语，这个账号不这么写');

  if (m.tag_count_median >= 1) {
    const tags = v.tags.slice(0, 5).map((t) => `#${t}`).join(' ');
    add(`带 ${Math.round(m.tag_count_median)} 个左右话题标签${tags ? `，常用：${tags}` : ''}`, `历史笔记标签数中位数 ${m.tag_count_median}`);
  }
  if (v.phrases.length > 0) add(`可以用这些它自己的说法：${v.phrases.slice(0, 5).join('、')}`, '在多篇历史笔记里重复出现');
  return { rules, avoid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples: the notes closest to the account's own middle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Few-shot material is picked by typicality, not by popularity: the notes whose shape sits closest to the account's
 * median. A viral outlier is exactly what we do not want a model to imitate.
 */
export function pickExamples(samples: readonly VoiceSample[], m: VoiceMetrics, limit = 3): VoiceExample[] {
  const used = usableSamples(samples);
  if (used.length === 0) return [];
  const distance = (s: VoiceSample): number => {
    const body = chars(s.content);
    const title = chars(s.title.trim());
    const paragraphs = s.content.split(/\n+/).filter((x) => x.trim()).length;
    const rel = (a: number, b: number) => (b > 0 ? Math.abs(a - b) / b : a > 0 ? 1 : 0);
    return rel(body, m.body_chars_median) + rel(title, m.title_chars_median) + rel(paragraphs, m.paragraph_count_median) * 0.5;
  };
  return [...used]
    .sort((a, b) => distance(a) - distance(b) || (b.published_at ?? '').localeCompare(a.published_at ?? ''))
    .slice(0, limit)
    .map((s) => ({
      platform_note_id: s.platform_note_id,
      title: s.title,
      excerpt: clip(s.content.trim(), EXAMPLE_EXCERPT_CHARS),
      why: '结构和长度最接近这个账号的平常水平',
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Imitating a voice is not reusing a post
// ─────────────────────────────────────────────────────────────────────────────

/** Similarity at which new text is treated as a rewrite of an old note rather than new writing in the same voice. */
export const COPY_SIMILARITY = 0.55;
/** …and the longest verbatim run that is allowed to survive from an old note. */
export const COPY_RUN_CHARS = 18;

export interface CopyCheck {
  copied: boolean;
  similarity: number;
  /** the note it resembles, when it resembles one */
  platform_note_id: string | null;
  /** the longest passage shared with that note */
  shared: string | null;
}

/** Longest common substring of two strings, bounded so a long note stays cheap to check. */
function longestShared(a: string, b: string, cap = 40): string {
  const x = [...a.replace(/\s+/g, '')];
  const y = [...b.replace(/\s+/g, '')];
  let best = '';
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] !== y[j - 1]) continue;
      cur[j] = prev[j - 1] + 1;
      if (cur[j] > best.length) {
        best = x.slice(i - cur[j], i).join('');
        if (best.length >= cap) return best;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Is this new text actually new? A voice profile teaches a model how the account writes; it must never hand it an old
 * note to re-publish. Both a high overall similarity and one long verbatim passage count as copying.
 */
export function checkCopy(text: string, samples: readonly VoiceSample[]): CopyCheck {
  const body = (text ?? '').trim();
  const out: CopyCheck = { copied: false, similarity: 0, platform_note_id: null, shared: null };
  if (!body) return out;
  const grams = charNgrams(normalizeText(body));
  for (const sample of samples) {
    const source = `${sample.title}\n${sample.content}`.trim();
    if (!source) continue;
    const similarity = Math.round(jaccard(grams, charNgrams(normalizeText(source))) * 1000) / 1000;
    const shared = longestShared(body, source);
    const copied = similarity >= COPY_SIMILARITY || [...shared].length >= COPY_RUN_CHARS;
    if (similarity > out.similarity || (copied && !out.copied)) {
      out.similarity = Math.max(out.similarity, similarity);
      if (copied) {
        out.copied = true;
        out.platform_note_id = sample.platform_note_id;
        out.shared = shared;
      }
    }
  }
  return out;
}
