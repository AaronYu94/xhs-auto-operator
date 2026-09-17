/**
 * Trend detection (B3): document frequency of automotive terms and models in the last `window_days` versus the
 * previous window of equal length, dated by published_at (DB corpus, plus provider data when supplied).
 * A term is rising when it appears in ≥ 2 units in the current window and more often than before.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Evidence, ResearchBrief, ResearchInsight } from '../../../core/types.ts';
import { DAY_MS } from '../../../core/time.ts';
import { findMatches, findModels, mapText, modelShortLabel } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import {
  analyzeCommentSignal,
  analyzeNoteSignal,
  assembleCorpus,
  assertBriefShape,
  buildResearchQueries,
  clauseQuote,
  commentRef,
  dataBasisNote,
  fetchProviderCorpus,
  isMarketingAnalysis,
  modelsLabel,
  noDataHeadline,
  noteRef,
  noteText,
  persistBrief,
  repeatedCommentRefs,
  researchInputValidator,
  resolveScope,
  simulationPrefix,
  type ProviderUsage,
  type ResearchCorpus,
  type ResearchInput,
  type ResearchNote,
  type ResearchScope,
} from '../shared.ts';

export const SKILL_NAME = 'trend-detection';
export const DEFAULT_TREND_WINDOW_DAYS = 7;
export const MIN_SUPPORT = 2;

/** Curated automotive purchase/usage terms (patterns on normalized text). */
export const TREND_TERMS: readonly { term: string; re: RegExp }[] = [
  { term: '落地价', re: /落地(?!窗|灯|扇|页)/ },
  { term: '优惠', re: /优惠|折扣|降价|让利|底价/ },
  { term: '现车', re: /现车|现货|库存|车源/ },
  { term: '提车', re: /提车|提了|提啦|喜提/ },
  { term: '贷款/金融', re: /贷款|分期|首付|月供|利率|0息|免息|低息|金融/ },
  { term: '置换', re: /置换|以旧换新|旧车/ },
  { term: '以租代购', re: /以租代购|融资租赁|租赁/ },
  { term: '补贴', re: /补贴|国补|地补/ },
  { term: '试驾', re: /试驾|看车|到店/ },
  { term: '续航/充电', re: /续航|掉电|电耗|充电/ },
  { term: '空间', re: /后排|空间|后备箱/ },
  { term: '油耗', re: /油耗/ },
  { term: '保养/质保', re: /保养|质保/ },
  { term: '性价比/值不值', re: /性价比|值得买|值不值|划算/ },
  { term: '选车对比', re: /还是|vs|对比|怎么选|选哪个|纠结/ },
  { term: '砍价', re: /砍价/ },
];

export interface TrendUnit {
  ref: string;
  text: string;
  context: string | null;
  published_at: string;
}

export interface TrendCount {
  term: string;
  current: number;
  previous: number;
  change: number;
  current_units: { unit: TrendUnit; start: number; end: number }[];
  previous_units: { unit: TrendUnit; start: number; end: number }[];
}

/** change = (current − previous) / max(1, previous), rounded to 2 decimals. */
export function changeRatio(current: number, previous: number): number {
  return Math.round(((current - previous) / Math.max(1, previous)) * 100) / 100;
}

/**
 * Dated discussion units. Managed accounts, dealer/solicitation voices ('需要优惠的私我', sales nicknames) and later copies
 * of the same author's comment never inflate trends.
 */
function unitsOf(notes: readonly ResearchNote[], scope: ResearchScope): TrendUnit[] {
  const out: TrendUnit[] = [];
  const repeats = repeatedCommentRefs(notes);
  for (const n of notes) {
    if (n.published_at && !n.managed_author && !isMarketingAnalysis(analyzeNoteSignal(n, scope))) {
      out.push({ ref: noteRef(n), text: noteText(n), context: null, published_at: n.published_at });
    }
    for (const c of n.comments) {
      if (!c.published_at || c.managed_author || !c.content.trim() || repeats.has(commentRef(c))) continue;
      if (isMarketingAnalysis(analyzeCommentSignal(n, c, scope))) continue;
      out.push({ ref: commentRef(c), text: c.content, context: n.title, published_at: c.published_at });
    }
  }
  return out;
}

/** Pure trend counting over dated units (exported for tests). */
export function countTrends(units: readonly TrendUnit[], nowMs: number, windowDays: number): { counts: TrendCount[]; current_units: number; previous_units: number } {
  const curFrom = nowMs - windowDays * DAY_MS;
  const prevFrom = nowMs - 2 * windowDays * DAY_MS;
  const map = new Map<string, TrendCount>();
  const entry = (term: string) => {
    let e = map.get(term);
    if (!e) {
      e = { term, current: 0, previous: 0, change: 0, current_units: [], previous_units: [] };
      map.set(term, e);
    }
    return e;
  };
  let currentUnits = 0;
  let previousUnits = 0;
  for (const unit of units) {
    const t = Date.parse(unit.published_at);
    // current = [now − window, now], previous = [now − 2·window, now − window)
    if (Number.isNaN(t) || t > nowMs || t < prevFrom) continue;
    const isCurrent = t >= curFrom;
    if (isCurrent) currentUnits++;
    else previousUnits++;
    const mt = mapText(unit.text);
    const seen = new Set<string>();
    const add = (term: string, start: number, end: number) => {
      if (seen.has(term)) return;
      seen.add(term);
      const e = entry(term);
      if (isCurrent) {
        e.current++;
        e.current_units.push({ unit, start, end });
      } else {
        e.previous++;
        e.previous_units.push({ unit, start, end });
      }
    };
    for (const m of findModels(unit.text, { context: unit.context })) add(modelShortLabel(m.model), m.start, m.end);
    for (const { term, re } of TREND_TERMS) {
      const hit = findMatches(mt, re)[0];
      if (hit) add(term, hit.start, hit.end);
    }
  }
  const counts = [...map.values()]
    .map((e) => ({ ...e, change: changeRatio(e.current, e.previous) }))
    .filter((e) => e.current >= MIN_SUPPORT || e.previous >= MIN_SUPPORT)
    .sort((a, b) => b.change - a.change || b.current - a.current || a.term.localeCompare(b.term));
  return { counts, current_units: currentUnits, previous_units: previousUnits };
}

function evidenceFor(term: string, units: TrendCount['current_units'], code: string): Evidence[] {
  return [...units]
    .sort((a, b) => b.unit.published_at.localeCompare(a.unit.published_at))
    .slice(0, 3)
    .map(({ unit, start, end }) => ({ code, label: `「${term}」`, quote: clauseQuote(mapText(unit.text), start, end), source_ref: unit.ref }));
}

export interface TrendAnalysis {
  findings: ResearchBrief['findings'];
  source_counts: ResearchBrief['source_counts'];
  /**
   * Both windows contain dated discussion. When one window has no data at all (e.g. collection started recently, or
   * stopped), every term would look "new" or "gone"; such runs report window volumes only and claim no rise or fall.
   */
  comparable: boolean;
  current_units: number;
  previous_units: number;
}

/** Pure analysis of a corpus gathered over 2 × window_days. */
export function analyzeTrendCorpus(corpus: ResearchCorpus, scope: ResearchScope, nowMs: number): TrendAnalysis {
  const days = scope.window_days;
  const { counts, current_units, previous_units } = countTrends(unitsOf(corpus.notes, scope), nowMs, days);
  const lookbackFrom = nowMs - 2 * days * DAY_MS;
  const dated = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= lookbackFrom && t <= nowMs;
  };
  const source_counts = {
    posts: corpus.notes.filter((n) => dated(n.published_at)).length,
    comments: corpus.notes.reduce((s, n) => s + n.comments.filter((c) => dated(c.published_at)).length, 0),
    provider_searches: corpus.provider.searches,
  };
  const base = { source_counts, current_units, previous_units };
  if (current_units + previous_units === 0) {
    return { ...base, comparable: false, findings: { headline: noDataHeadline(scope, corpus, days * 2), insights: [], trends: [] } };
  }
  const trends = counts.map((c) => ({ term: c.term, current: c.current, previous: c.previous, change: c.change }));
  const volume = `近${days}天${current_units}条 vs 前${days}天${previous_units}条`;
  if (current_units === 0 || previous_units === 0) {
    const hasCurrent = current_units > 0;
    const windowLabel = hasCurrent ? `近${days}天` : `前${days}天`;
    const missingLabel = hasCurrent ? `前${days}天` : `近${days}天`;
    const top = counts
      .map((c) => ({ term: c.term, n: hasCurrent ? c.current : c.previous, units: hasCurrent ? c.current_units : c.previous_units }))
      .filter((x) => x.n >= MIN_SUPPORT)
      .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term));
    const insights: ResearchInsight[] = top.slice(0, 5).map((x) => ({
      text: `${windowLabel}「${x.term}」被提及${x.n}次（${missingLabel}没有可比数据，暂不判断升降）`,
      metric: x.n,
      evidence: evidenceFor(x.term, x.units, 'trend_volume'),
    }));
    const topPart = top[0]
      ? `；${windowLabel}提及最多的是「${top[0].term}」（${top[0].n}次）`
      : `；${windowLabel}没有达到最小支持度（≥${MIN_SUPPORT}次）的词`;
    const headline = `${simulationPrefix(corpus)}${modelsLabel(scope)}相关讨论（${volume}）：${missingLabel}没有可比的讨论数据，暂不判断升降${topPart}${dataBasisNote(corpus)}。`;
    return { ...base, comparable: false, findings: { headline, insights, trends } };
  }
  const rising = counts.filter((c) => c.current >= MIN_SUPPORT && c.current > c.previous);
  const falling = counts.filter((c) => c.previous >= MIN_SUPPORT && c.current < c.previous).sort((a, b) => a.change - b.change || a.term.localeCompare(b.term));
  const insights: ResearchInsight[] = [];
  for (const c of rising.slice(0, 5)) {
    insights.push({
      text:
        c.previous === 0
          ? `「${c.term}」新出现并升温：近${days}天${c.current}次，前${days}天0次`
          : `「${c.term}」讨论上升：近${days}天${c.current}次，前${days}天${c.previous}次（+${Math.round(c.change * 100)}%）`,
      metric: c.change,
      evidence: evidenceFor(c.term, c.current_units, 'trend_rising'),
    });
  }
  for (const c of falling.slice(0, 3)) {
    insights.push({
      text: `「${c.term}」讨论下降：近${days}天${c.current}次，前${days}天${c.previous}次（${Math.round(c.change * 100)}%）`,
      metric: c.change,
      evidence: evidenceFor(c.term, c.previous_units, 'trend_falling'),
    });
  }
  const prefix = simulationPrefix(corpus);
  const top = rising[0];
  const risePart = top
    ? `上升最快的是「${top.term}」（近${days}天${top.current}次，前${days}天${top.previous}次）`
    : `没有达到最小支持度（≥${MIN_SUPPORT}次）的上升词`;
  const headline = `${prefix}${modelsLabel(scope)}相关讨论趋势（${volume}）：${risePart}${dataBasisNote(corpus)}。`;
  return { ...base, comparable: true, findings: { headline, insights, trends } };
}

export interface TrendOptions {
  /** provider notes gathered over 2 × window_days (the async skill path supplies them when search is AVAILABLE) */
  provider_corpus?: { notes: ResearchNote[]; usage: ProviderUsage } | null;
}

/** Synchronous trend detection over the DB corpus (plus provider data when supplied). Persists a brief. */
export function runTrendDetection(ctx: AppContext, input: ResearchInput, opts: TrendOptions = {}): ResearchBrief {
  const scope = resolveScope(ctx, input, DEFAULT_TREND_WINDOW_DAYS);
  const lookback = scope.window_days * 2;
  const corpus = assembleCorpus(ctx, scope, opts.provider_corpus ?? null, lookback, { include_competitors: true });
  const analysis = analyzeTrendCorpus(corpus, scope, ctx.clock.now().getTime());
  return persistBrief(ctx, {
    kind: 'trend',
    skill: SKILL_NAME,
    scope,
    corpus,
    findings: analysis.findings,
    queries: corpus.provider.queries.map((q) => q.query),
    source_counts: analysis.source_counts,
    extra_inputs: {
      min_support: MIN_SUPPORT,
      windows: { current_days: scope.window_days, previous_days: scope.window_days },
      units: { current: analysis.current_units, previous: analysis.previous_units },
      comparable: analysis.comparable,
    },
  });
}

/** Skill path: gathers bounded provider data over both windows when search is AVAILABLE, then detects trends. */
export async function runTrendDetectionWithProvider(ctx: AppContext, input: ResearchInput): Promise<ResearchBrief> {
  const scope = resolveScope(ctx, input, DEFAULT_TREND_WINDOW_DAYS);
  const provider = await fetchProviderCorpus(ctx, scope, buildResearchQueries('trend', scope), scope.window_days * 2, { include_competitors: true });
  return runTrendDetection(ctx, input, { provider_corpus: provider });
}

export const skill = defineSkill<ResearchInput, ResearchBrief>({
  name: SKILL_NAME,
  category: 'research',
  agent: 'research-agent',
  description:
    '趋势发现：按发布时间比较最近窗口与上一窗口中车型与购车关键词（落地价、优惠、现车、置换、以租代购等）的讨论量，输出上升/下降词、变化率与逐字证据（最小支持度2），保存调研简报。',
  input: researchInputValidator,
  run(ctx, input) {
    return runTrendDetectionWithProvider(ctx, input);
  },
  validateOutput: assertBriefShape,
});
