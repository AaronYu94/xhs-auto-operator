/**
 * Competitor research (B3): which competitor models are discussed together with the dealer's models, how often
 * buyers explicitly compare them, and which sentiment cues (香 / 值 / 后悔 / 不值) attach to which model.
 * Competitor relationships come from the automotive lexicon (competitorsOf); mentions from findModels.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Evidence, ResearchBrief, ResearchInsight } from '../../../core/types.ts';
import { clauseAt, competitorsOf, findModels, mapText, modelShortLabel, type MappedText } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { detectConversationIntents } from '../../sales/conversation/nlu.ts';
import {
  analyzeCommentSignal,
  analyzeNoteSignal,
  assertBriefShape,
  buildResearchQueries,
  clauseQuote,
  commentRef,
  corpusCounts,
  dataBasisNote,
  gatherResearchCorpus,
  isMarketingAnalysis,
  noDataHeadline,
  noteRef,
  noteText,
  persistBrief,
  repeatedCommentRefs,
  researchInputValidator,
  resolveScope,
  simulationPrefix,
  type ResearchCorpus,
  type ResearchInput,
  type ResearchScope,
} from '../shared.ts';

export const SKILL_NAME = 'competitor-research';

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

// ─────────────────────────────────────────────────────────────────────────────
// Sentiment cues
// ─────────────────────────────────────────────────────────────────────────────

export const SENTIMENT_CUES = ['香', '值', '不后悔', '后悔', '不值', '不香'] as const;
export type SentimentCue = (typeof SENTIMENT_CUES)[number];
export const CUE_POLARITY: Record<SentimentCue, 'positive' | 'negative'> = {
  香: 'positive',
  值: 'positive',
  不后悔: 'positive',
  后悔: 'negative',
  不值: 'negative',
  不香: 'negative',
};

/** '香' in words that are not the slang judgement ('香菜', '香水', '香港', '香味' …) */
const NOT_SLANG_XIANG = '(?![菜水港味料肠辣蕉油囊薰气精皂])';
/** Pattern order = precedence: a later cue never overlaps an earlier hit ('不值' is never also '值', '不香' never '香'). */
const CUE_PATTERNS: readonly { cue: SentimentCue; re: RegExp }[] = [
  { cue: '不后悔', re: /(?:不|没|从不|不会|没有)后悔/g },
  { cue: '后悔', re: /后悔/g },
  { cue: '不值', re: /(?:不|没)(?:太|那么|有那么|怎么)?值(?:得)?/g },
  { cue: '不香', re: new RegExp(`(?:不|没)(?:太|那么|有那么|怎么)?香${NOT_SLANG_XIANG}`, 'g') },
  { cue: '值', re: /值得|值了|超值|很值|挺值|真值|太值/g },
  { cue: '香', re: new RegExp(`(?:真|很|确实|太|挺|好|超|巨|真的|这么|那么|多么)香${NOT_SLANG_XIANG}|香(?=$|[,。!?~\\s了啊呀哦])`, 'g') },
];
/**
 * Clauses that ask rather than judge ('值得买吗', '值不值', '香不香') never count as sentiment. '么' only marks a question
 * when it is not part of an intensifier ('这么香', '没那么值得').
 */
const QUESTION_CLAUSE_RE = /[?]|吗|(?<![这那多])么|呢|值不值|香不香|会不会后悔|后不后悔/;

export interface CueHit {
  cue: SentimentCue;
  start: number;
  end: number;
}

/** Non-overlapping sentiment cues in normalized text, skipping question clauses (longest cue wins). */
export function findSentimentCues(mt: MappedText): CueHit[] {
  const hits: CueHit[] = [];
  for (const { cue, re } of CUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mt.norm)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && h.start < end)) continue;
      if (cue === '值' && /[不没]$/.test(mt.norm.slice(Math.max(0, start - 1), start))) continue;
      if (QUESTION_CLAUSE_RE.test(clauseAt(mt, start).text)) continue;
      hits.push({ cue, start, end });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

interface ModelSpan {
  model: string;
  brand: string;
  start: number;
  end: number;
}

/** Model a cue refers to: same clause (nearest), else nearest preceding mention, else nearest following, else fallback. */
function attributeCue(mt: MappedText, hit: CueHit, spans: readonly ModelSpan[], fallback: string | null): string | null {
  if (spans.length > 0) {
    const clause = clauseAt(mt, hit.start);
    const inClause = spans.filter((s) => s.start >= clause.start && s.end <= Math.max(clause.end, hit.end));
    const dist = (s: ModelSpan) => (s.end <= hit.start ? hit.start - s.end : s.start - hit.end);
    if (inClause.length > 0) return [...inClause].sort((a, b) => Math.abs(dist(a)) - Math.abs(dist(b)))[0].model;
    const before = spans.filter((s) => s.end <= hit.start).sort((a, b) => b.end - a.end)[0];
    if (before) return before.model;
    const after = spans.filter((s) => s.start >= hit.end).sort((a, b) => a.start - b.start)[0];
    if (after) return after.model;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

interface PairExample {
  evidence: Evidence;
  direct: boolean;
  comparison: boolean;
  likes: number;
}

interface PairStat {
  our: string;
  competitor: string;
  brand: string;
  mentions: number;
  comparisons: number;
  examples: PairExample[];
}

interface ModelSentiment {
  model: string;
  cues: Map<SentimentCue, number>;
  positive: number;
  negative: number;
  evidence: Evidence[];
}

const exampleRank = (a: PairExample, b: PairExample) =>
  Number(b.comparison) - Number(a.comparison) || Number(b.direct) - Number(a.direct) || b.likes - a.likes;

/** Pure analysis of a gathered corpus (exported for reuse and tests). */
export function analyzeCompetitorCorpus(corpus: ResearchCorpus, scope: ResearchScope): ResearchBrief['findings'] {
  const counts = corpusCounts(corpus);
  if (counts.posts === 0 && counts.comments === 0) return { headline: noDataHeadline(scope, corpus), insights: [], competitors: [] };

  const ours = scope.models;
  const compOf = new Map<string, Map<string, { brand: string; model: string }>>();
  const tracked = new Set<string>(ours.map(key));
  for (const m of ours) {
    const list = new Map<string, { brand: string; model: string }>();
    for (const c of competitorsOf(scope.brand, m)) {
      list.set(key(c.model), { brand: c.brand, model: c.model });
      tracked.add(key(c.model));
    }
    compOf.set(m, list);
  }

  const pairs = new Map<string, PairStat>();
  const pairFor = (our: string, comp: { brand: string; model: string }) => {
    const k = `${key(our)}|${key(comp.model)}`;
    let p = pairs.get(k);
    if (!p) {
      p = { our, competitor: comp.model, brand: comp.brand, mentions: 0, comparisons: 0, examples: [] };
      pairs.set(k, p);
    }
    return p;
  };
  const sentiment = new Map<string, ModelSentiment>();
  const sentimentFor = (model: string) => {
    let s = sentiment.get(key(model));
    if (!s) {
      s = { model, cues: new Map(), positive: 0, negative: 0, evidence: [] };
      sentiment.set(key(model), s);
    }
    return s;
  };

  const analyzeUnit = (unit: {
    text: string;
    context: string | null;
    ref: string;
    likes: number;
    parentModels: Set<string>;
    fallbackModel: string | null;
  }): Set<string> => {
    const mt = mapText(unit.text);
    const spans: ModelSpan[] = findModels(unit.text, { context: unit.context }).map((m) => ({ model: m.model, brand: m.brand, start: m.start, end: m.end }));
    const stated = new Set(spans.map((s) => key(s.model)));
    const comparison = detectConversationIntents(unit.text).intents.includes('model_comparison');

    for (const our of ours) {
      const competitors = compOf.get(our);
      if (!competitors) continue;
      const ourStated = stated.has(key(our));
      if (!ourStated && !unit.parentModels.has(key(our))) continue;
      for (const span of spans) {
        const comp = competitors.get(key(span.model));
        if (!comp) continue;
        const p = pairFor(our, comp);
        if (p.examples.some((e) => e.evidence.source_ref === unit.ref)) continue;
        p.mentions += 1;
        const isComparison = ourStated && comparison;
        if (isComparison) p.comparisons += 1;
        p.examples.push({
          evidence: {
            code: isComparison ? 'competitor_comparison' : 'competitor_mention',
            label: isComparison ? `对比 ${modelShortLabel(our)} vs ${modelShortLabel(span.model)}` : `与${modelShortLabel(our)}同框提及${modelShortLabel(span.model)}`,
            quote: clauseQuote(mt, span.start, span.end),
            source_ref: unit.ref,
          },
          direct: ourStated,
          comparison: isComparison,
          likes: unit.likes,
        });
      }
    }

    for (const hit of findSentimentCues(mt)) {
      const model = attributeCue(mt, hit, spans, unit.fallbackModel);
      if (!model || !tracked.has(key(model))) continue;
      const s = sentimentFor(model);
      s.cues.set(hit.cue, (s.cues.get(hit.cue) ?? 0) + 1);
      if (CUE_POLARITY[hit.cue] === 'positive') s.positive += 1;
      else s.negative += 1;
      s.evidence.push({ code: `sentiment:${hit.cue}`, label: `${modelShortLabel(model)}「${hit.cue}」`, quote: clauseQuote(mt, hit.start, hit.end), source_ref: unit.ref });
    }
    return stated;
  };

  const repeats = repeatedCommentRefs(corpus.notes);
  for (const note of corpus.notes) {
    const text = noteText(note);
    // managed-account and dealer/marketing notes are not public discussion themselves, but buyers' comments under them are
    const noteIsDiscussion = !note.managed_author && !isMarketingAnalysis(analyzeNoteSignal(note, scope));
    const noteModels = noteIsDiscussion
      ? analyzeUnit({ text, context: null, ref: noteRef(note), likes: note.like_count, parentModels: new Set(), fallbackModel: null })
      : new Set(findModels(text).map((m) => key(m.model)));
    const titleModels = findModels(note.title);
    const fallback = titleModels.length === 1 ? titleModels[0].model : null;
    for (const comment of note.comments) {
      if (comment.managed_author || !comment.content.trim() || repeats.has(commentRef(comment))) continue;
      if (isMarketingAnalysis(analyzeCommentSignal(note, comment, scope))) continue;
      analyzeUnit({
        text: comment.content,
        context: note.title,
        ref: commentRef(comment),
        likes: comment.like_count,
        parentModels: noteModels,
        fallbackModel: fallback,
      });
    }
  }

  const rankedPairs = [...pairs.values()]
    .map((p) => ({ ...p, examples: [...p.examples].sort(exampleRank) }))
    .sort((a, b) => b.mentions - a.mentions || b.comparisons - a.comparisons || a.our.localeCompare(b.our) || a.competitor.localeCompare(b.competitor));
  const competitors = rankedPairs.map((p) => ({
    brand: p.brand,
    model: p.competitor,
    mentions: p.mentions,
    comparison_with: p.our,
    example_quote: p.examples[0]?.evidence.quote ?? '',
  }));

  const insights: ResearchInsight[] = [];
  for (const p of rankedPairs.slice(0, 3)) {
    insights.push({
      text: `「${modelShortLabel(p.our)} vs ${modelShortLabel(p.competitor)}」同框讨论${p.mentions}次（其中明确对比${p.comparisons}次）`,
      metric: p.mentions,
      evidence: p.examples.slice(0, 3).map((e) => e.evidence),
    });
  }
  const rankedSentiment = [...sentiment.values()].sort(
    (a, b) => b.positive + b.negative - (a.positive + a.negative) || b.positive - a.positive || a.model.localeCompare(b.model),
  );
  for (const s of rankedSentiment.slice(0, 4)) {
    const breakdown = SENTIMENT_CUES.filter((c) => s.cues.has(c)).map((c) => `「${c}」${s.cues.get(c)}次`).join('、');
    insights.push({
      text: `情绪词：${modelShortLabel(s.model)} ${breakdown}（正向${s.positive}次、负向${s.negative}次）`,
      metric: s.positive - s.negative,
      evidence: s.evidence.slice(0, 3),
    });
  }

  const prefix = simulationPrefix(corpus);
  const top = rankedPairs[0];
  const pairPart = top
    ? `「${modelShortLabel(top.our)} vs ${modelShortLabel(top.competitor)}」同框最多（${top.mentions}次，明确对比${top.comparisons}次）`
    : '未发现本店车型与竞品的同框讨论';
  const sTop = rankedSentiment[0];
  const sentimentPart = sTop
    ? `；情绪词最多指向${modelShortLabel(sTop.model)}（${SENTIMENT_CUES.filter((c) => sTop.cues.has(c)).map((c) => `「${c}」${sTop.cues.get(c)}次`).join('、')}）`
    : '';
  const headline = `${prefix}近${scope.window_days}天竞品讨论（${counts.posts}篇笔记、${counts.comments}条评论）：${pairPart}${sentimentPart}${dataBasisNote(corpus)}。`;
  return { headline, insights, competitors };
}

export async function runCompetitorResearch(ctx: AppContext, input: ResearchInput): Promise<ResearchBrief> {
  const scope = resolveScope(ctx, input);
  const queries = buildResearchQueries('competitor', scope);
  // competitor threads (e.g. a Model 3 owner thread a comparison search returned) are competitor research data
  const corpus = await gatherResearchCorpus(ctx, scope, queries, scope.window_days, { include_competitors: true });
  const findings = analyzeCompetitorCorpus(corpus, scope);
  return persistBrief(ctx, { kind: 'competitor', skill: SKILL_NAME, scope, corpus, findings, queries });
}

export const skill = defineSkill<ResearchInput, ResearchBrief>({
  name: SKILL_NAME,
  category: 'research',
  agent: 'research-agent',
  description:
    '竞品调研：统计与本店车型同框讨论的竞品车型、明确对比次数，以及“香/值/后悔/不值”等情绪词指向的车型，全部附逐字证据并保存调研简报。',
  input: researchInputValidator,
  run(ctx, input) {
    return runCompetitorResearch(ctx, input);
  },
  validateOutput: assertBriefShape,
});
