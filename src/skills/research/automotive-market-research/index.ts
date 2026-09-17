/**
 * Automotive market research (B3): price and discount talk in public discussion (USER statements, numbers quoted
 * verbatim, first-hand reports kept apart from numbers inside questions / budgets / hearsay) set against the dealer's
 * ACTIVE offers and inventory from Dealer Brain (DEALER facts), plus regional demand by IP 属地. User talk and dealer
 * facts are always labelled separately (【用户讨论】 / 【门店事实】).
 */
import type { AppContext } from '../../../app/context.ts';
import { formatCny, meaningfulLength } from '../../../core/text.ts';
import type { Evidence, Offer, ResearchBrief, ResearchInsight } from '../../../core/types.ts';
import { clauseAt, findMatches, findModels, mapText, modelShortLabel, parseBudget, provinceOfIp, type MappedText } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { exactCny, findInventory, getActiveOffers } from '../../operations/dealer-brain/index.ts';
import { dealerTz, formatMonthDay, localDateOf } from '../../operations/dealer-brain/shared.ts';
import {
  analyzeComments,
  analyzeNoteSignal,
  assertBriefShape,
  buildResearchQueries,
  clauseAround,
  clauseQuote,
  commentEvidence,
  commentRef,
  corpusCounts,
  dataBasisNote,
  excerpt,
  exampleOrder,
  gatherResearchCorpus,
  isMarketingAnalysis,
  isQuestionForm,
  noDataHeadline,
  noteRef,
  noteText,
  pct,
  persistBrief,
  repeatedCommentRefs,
  researchInputValidator,
  resolveScope,
  simulationPrefix,
  type AnalyzedComment,
  type ResearchCorpus,
  type ResearchInput,
  type ResearchScope,
} from '../shared.ts';

export const SKILL_NAME = 'automotive-market-research';

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

// ─────────────────────────────────────────────────────────────────────────────
// Number extraction (user statements)
// ─────────────────────────────────────────────────────────────────────────────

const NUM = '(\\d{1,3}(?:\\.\\d{1,2})?)';
const LANDING_PRICE_RES: readonly RegExp[] = [
  new RegExp(`落地(?:价格?)?(?:是|为|大概|大约|差不多|才|只要|要|在|就|总共|一共|:)? *${NUM} *(万|w)(?![a-z])`),
  new RegExp(`${NUM} *(万|w)(?![a-z]) *(?:多|出头|左右)? *(?:就能|就|能|可以|才)? *落地(?!多少|价多少|吗)`),
];
const DISCOUNT_AMOUNT_RES: readonly RegExp[] = [
  new RegExp(`(?:优惠|便宜|降价|降了|让利|少了|砍了|砍下|直降|减了|返了?|补贴)(?:了|有|能有|大概|差不多|:)? *${NUM} *(万|w|千|k)(?![a-z])`),
  new RegExp(`${NUM} *(万|w|千|k)(?![a-z]) *(?:的)?(?:现金)?(?:优惠|折扣|让利)`),
];
const LANDING_RANGE = { min: 30_000, max: 3_000_000 };
const DISCOUNT_RANGE = { min: 500, max: 500_000 };

/** Clause cues marking a number as a budget, condition, wish or hearsay rather than a first-hand report. */
const HYPOTHETICAL_RE = /预算|如果|要是|假如|假设|的话|能不能|可不可以|能否|想要|希望|控制在|以内|之内|听说|据说|听人说|网上说|传闻/;
/** A question clause this short right after the number is about the number ('30万落地，能拿下吗'). */
const FOLLOW_UP_QUESTION_MAX_CHARS = 6;

export interface ExtractedAmount {
  value: number;
  /** verbatim matched phrase */
  phrase: string;
  /** verbatim clause containing the phrase */
  quote: string;
  /** phrased as a question, budget, condition or hearsay — the user did not report paying / getting it */
  hypothetical: boolean;
  /** normalized offsets of the phrase (for model attribution) */
  start: number;
  end: number;
}

export interface AmountMention {
  value: number;
  phrase: string;
  quote: string;
  hypothetical: boolean;
  source_ref: string;
  model: string | null;
}

function amountValue(num: string, unit: string): number {
  const n = Number(num);
  return Math.round(unit === '千' || unit === 'k' ? n * 1000 : n * 10_000);
}

function isHypotheticalAt(mt: MappedText, start: number, end: number): boolean {
  const clause = clauseAt(mt, start);
  const clauseEnd = Math.max(clause.end, end);
  const text = mt.norm.slice(clause.start, clauseEnd);
  if (HYPOTHETICAL_RE.test(text) || isQuestionForm(text)) return true;
  const breakChar = mt.norm[clauseEnd];
  if (breakChar !== ',' && breakChar !== '、') return false;
  const next = clauseAt(mt, clauseEnd + 1);
  return next.text.length > 0 && meaningfulLength(next.text) <= FOLLOW_UP_QUESTION_MAX_CHARS && isQuestionForm(next.text);
}

/** Landing prices / discount amounts stated in a text (verbatim phrases, parsed values, in-range only). */
export function extractAmounts(text: string, kind: 'landing' | 'discount'): ExtractedAmount[] {
  const mt = mapText(text);
  const res = kind === 'landing' ? LANDING_PRICE_RES : DISCOUNT_AMOUNT_RES;
  const range = kind === 'landing' ? LANDING_RANGE : DISCOUNT_RANGE;
  const out: ExtractedAmount[] = [];
  for (const re of res) {
    for (const h of findMatches(mt, re)) {
      if (out.some((o) => h.start < o.end && o.start < h.end)) continue;
      const value = amountValue(h.groups[1] ?? '', h.groups[2] ?? '万');
      if (!Number.isFinite(value) || value < range.min || value > range.max) continue;
      out.push({ value, phrase: h.quote, quote: clauseQuote(mt, h.start, h.end), hypothetical: isHypotheticalAt(mt, h.start, h.end), start: h.start, end: h.end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dealer facts
// ─────────────────────────────────────────────────────────────────────────────

/** Offer rendered only from its structured fields (never computes a landing price). */
export function describeOfferFact(offer: Offer, tz: string): string {
  const parts: string[] = [];
  switch (offer.type) {
    case 'finance':
      if (offer.term_months !== null) parts.push(`${offer.term_months}期`);
      if (offer.apr !== null) parts.push(offer.apr === 0 ? '0息' : `年利率${Math.round(offer.apr * 10_000) / 100}%`);
      if (offer.down_payment_pct !== null) parts.push(`首付${Math.round(offer.down_payment_pct * 100)}%`);
      break;
    case 'lease':
      if (offer.term_months !== null) parts.push(`${offer.term_months}期`);
      if (offer.down_payment_pct !== null) parts.push(`首付${Math.round(offer.down_payment_pct * 100)}%`);
      break;
    default:
      if (offer.amount !== null) parts.push(`金额${exactCny(offer.amount)}`);
  }
  parts.push(`有效期至${formatMonthDay(localDateOf(offer.valid_until, tz))}`);
  return `${offer.title}（${parts.join('，')}）`;
}

const offerEvidence = (offer: Offer): Evidence => ({
  code: 'dealer_offer',
  label: `门店事实：${offer.title}`,
  quote: offer.title,
  source_ref: `offer:${offer.id}`,
});

export interface MarketFacts {
  /** active offers per scope model (model-specific or trim-specific) */
  offers_by_model: Map<string, Offer[]>;
  /** active offers that apply to every vehicle */
  general_offers: Offer[];
  inventory_by_model: Map<string, { in_stock: number; in_transit: number; rows: { id: string; trim: string; label: string }[] }>;
  sources: Map<string, string[]>;
}

export function loadMarketFacts(ctx: AppContext, scope: ResearchScope): MarketFacts {
  const offersByModel = new Map<string, Offer[]>();
  const general = new Map<string, Offer>();
  const sources = new Map<string, string[]>();
  const inventoryByModel: MarketFacts['inventory_by_model'] = new Map();
  for (const model of scope.models) {
    const specific: Offer[] = [];
    for (const offer of getActiveOffers(ctx, scope.dealer.id, { model })) {
      sources.set(`offer:${offer.id}`, [offer.title]);
      if (!offer.vehicle_id && !offer.model) general.set(offer.id, offer);
      else specific.push(offer);
    }
    offersByModel.set(model, specific);
    const inv = { in_stock: 0, in_transit: 0, rows: [] as { id: string; trim: string; label: string }[] };
    for (const match of findInventory(ctx, scope.dealer.id, { model, statuses: ['in_stock', 'in_transit'] })) {
      if (key(match.vehicle.model) !== key(model)) continue;
      const row = match.inventory;
      if (row.status === 'in_stock') inv.in_stock += row.quantity;
      else inv.in_transit += row.quantity;
      const statusLabel = row.status === 'in_stock' ? '现车' : '在途';
      inv.rows.push({ id: row.id, trim: match.vehicle.trim, label: `门店事实：${match.vehicle.trim} ${row.exterior_color}/${row.interior_color} ${statusLabel}×${row.quantity}` });
      sources.set(`inventory:${row.id}`, [match.vehicle.trim]);
    }
    inventoryByModel.set(model, inv);
  }
  return { offers_by_model: offersByModel, general_offers: [...general.values()], inventory_by_model: inventoryByModel, sources };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_QUESTIONS: ReadonlySet<string> = new Set(['price', 'landing_price', 'discount']);
const LANDING_OR_PRICE_QUESTIONS: ReadonlySet<string> = new Set(['price', 'landing_price']);
const DISCOUNT_QUESTIONS: ReadonlySet<string> = new Set(['discount']);

const asks = (item: AnalyzedComment, codes: ReadonlySet<string>) => item.analysis.detection.transaction_questions.some((t) => codes.has(t));

function questionQuote(item: AnalyzedComment, codes: readonly string[]): string {
  const hit = item.analysis.detection.evidence.find((e) => codes.includes(e.code) && e.quote && e.source_ref === undefined);
  return (hit?.quote ? clauseAround(item.comment.content, hit.quote) : null) ?? excerpt(item.comment.content);
}

function modelOfItem(item: AnalyzedComment, scope: ResearchScope): string | null {
  const m = item.analysis.detection.intent.model;
  if (!m) return null;
  return scope.models.find((s) => key(s) === key(m)) ?? null;
}

/**
 * The place a buyer EXPLICITLY states when it is outside the dealer's province (ARCHITECTURE §5.2); IP 属地-only
 * provinces are noisy and never exclude a buyer. Such buyers are not demand for this dealer's inventory or offers.
 */
export function statedOutOfArea(item: AnalyzedComment, scope: ResearchScope): string | null {
  const intent = item.analysis.detection.intent;
  if (!intent.province || (intent.inferred_fields ?? []).includes('province')) return null;
  return intent.province !== scope.dealer.province ? (intent.location ?? intent.province) : null;
}

const formatValues = (values: number[]) => [...new Set(values)].sort((a, b) => a - b).map((v) => formatCny(v)).join('、');

interface ModelSpan {
  model: string;
  start: number;
  end: number;
}

/** Scope model mentioned nearest before the amount, else the nearest after it. */
function modelNear(spans: readonly ModelSpan[], at: number): string | null {
  const before = spans.filter((s) => s.end <= at).sort((a, b) => b.end - a.end)[0];
  if (before) return before.model;
  return spans.filter((s) => s.start >= at).sort((a, b) => a.start - b.start)[0]?.model ?? null;
}

function amountEvidence(kind: 'landing' | 'discount', m: AmountMention): Evidence {
  const label =
    kind === 'landing'
      ? m.hypothetical
        ? `用户讨论：提问/预算/假设中的落地价「${m.phrase}」`
        : `用户讨论：自述落地价「${m.phrase}」`
      : m.hypothetical
        ? `用户讨论：提问/传闻中的优惠「${m.phrase}」`
        : `用户讨论：自述优惠「${m.phrase}」`;
  return { code: kind === 'landing' ? 'user_landing_price' : 'user_discount_mention', label, quote: m.quote, source_ref: m.source_ref };
}

/**
 * Landing prices and discount amounts from public text. Managed-account and dealer/marketing notes and comments, and
 * later copies of the same author's comment, are never user talk. Amounts are attributed to the nearest scope model in
 * the same text; a comment naming no scope model inherits the thread's model when the note names exactly one.
 */
function collectAmounts(corpus: ResearchCorpus, scope: ResearchScope, analyzed: readonly AnalyzedComment[]): { landing: AmountMention[]; discounts: AmountMention[] } {
  const landing: AmountMention[] = [];
  const discounts: AmountMention[] = [];
  const byRef = new Map(analyzed.map((a) => [commentRef(a.comment), a]));
  const repeats = repeatedCommentRefs(corpus.notes);
  const scopeModel = (m: string) => scope.models.find((s) => key(s) === key(m)) ?? null;
  const spansOf = (text: string, context: string | null): ModelSpan[] =>
    findModels(text, { context })
      .map((m) => ({ model: scopeModel(m.model), start: m.start, end: m.end }))
      .filter((s): s is ModelSpan => s.model !== null);
  const add = (text: string, ref: string, spans: readonly ModelSpan[], fallback: string | null) => {
    for (const a of extractAmounts(text, 'landing')) {
      landing.push({ value: a.value, phrase: a.phrase, quote: a.quote, hypothetical: a.hypothetical, source_ref: ref, model: modelNear(spans, a.start) ?? fallback });
    }
    for (const a of extractAmounts(text, 'discount')) {
      discounts.push({ value: a.value, phrase: a.phrase, quote: a.quote, hypothetical: a.hypothetical, source_ref: ref, model: modelNear(spans, a.start) ?? fallback });
    }
  };
  for (const note of corpus.notes) {
    const text = noteText(note);
    const noteSpans = spansOf(text, null);
    const threadModels = [...new Set(noteSpans.map((s) => s.model))];
    const threadModel = threadModels.length === 1 ? threadModels[0] : null;
    if (!note.managed_author && !isMarketingAnalysis(analyzeNoteSignal(note, scope))) add(text, noteRef(note), noteSpans, null);
    for (const c of note.comments) {
      const ref = commentRef(c);
      if (c.managed_author || repeats.has(ref)) continue;
      const item = byRef.get(ref);
      if (!item || isMarketingAnalysis(item.analysis)) continue;
      add(c.content, ref, spansOf(c.content, note.title), threadModel);
    }
  }
  return { landing, discounts };
}

/** Pure analysis (exported for reuse and tests); dealer facts are passed in so the function stays DB-free. */
export function analyzeMarketCorpus(corpus: ResearchCorpus, scope: ResearchScope, facts: MarketFacts): ResearchBrief['findings'] {
  const counts = corpusCounts(corpus);
  if (counts.posts === 0 && counts.comments === 0) return { headline: noDataHeadline(scope, corpus), insights: [] };
  const tz = dealerTz(scope.dealer);
  const days = scope.window_days;
  const analyzed = analyzeComments(corpus, scope);
  const questions = analyzed.filter((a) => a.question);
  const localQuestions = questions.filter((q) => statedOutOfArea(q, scope) === null);
  const awayQuestions = questions.filter((q) => statedOutOfArea(q, scope) !== null);
  const insights: ResearchInsight[] = [];

  // ── user statements: landing prices & discount amounts ─────────────────────
  const { landing, discounts } = collectAmounts(corpus, scope, analyzed);
  const priceAsks = questions.filter((q) => asks(q, LANDING_OR_PRICE_QUESTIONS));
  const discountAsks = questions.filter((q) => asks(q, DISCOUNT_QUESTIONS));
  const priceOrDiscountAsks = questions.filter((q) => asks(q, PRICE_QUESTIONS));
  const reportedLanding = landing.filter((l) => !l.hypothetical);
  const hypotheticalLanding = landing.filter((l) => l.hypothetical);

  if (landing.length > 0) {
    const head =
      reportedLanding.length > 0
        ? `【用户讨论·落地价】用户自述的落地价：${formatValues(reportedLanding.map((l) => l.value))}（${reportedLanding.length}处）`
        : '【用户讨论·落地价】公开讨论中没有用户自述的落地价';
    const tail =
      hypotheticalLanding.length > 0
        ? `${reportedLanding.length > 0 ? '；另有' : '；'}${hypotheticalLanding.length}处落地价出现在提问/预算/假设中：${formatValues(hypotheticalLanding.map((l) => l.value))}`
        : '';
    insights.push({
      text: `${head}${tail}（均为用户说法，不代表门店报价）`,
      metric: landing.length,
      evidence: [...reportedLanding.slice(0, 3), ...hypotheticalLanding.slice(0, 2)].map((l) => amountEvidence('landing', l)),
    });
  } else if (priceAsks.length > 0) {
    insights.push({
      text: `【用户讨论·价格】${priceAsks.length}条买家评论在问价格/落地价，但公开讨论中没有出现具体落地价数字`,
      metric: priceAsks.length,
      evidence: [...priceAsks].sort(exampleOrder).slice(0, 3).map((q) => commentEvidence('user_price_question', '用户讨论：问价/问落地价', q.comment, questionQuote(q, ['landing_price', 'price']))),
    });
  }

  if (discounts.length > 0 || discountAsks.length > 0) {
    const reported = discounts.filter((d) => !d.hypothetical);
    const hypothetical = discounts.filter((d) => d.hypothetical);
    const amountParts = [
      reported.length > 0 ? `用户自述拿到的优惠：${formatValues(reported.map((d) => d.value))}` : '',
      hypothetical.length > 0 ? `提问/传闻中的优惠金额：${formatValues(hypothetical.map((d) => d.value))}` : '',
    ].filter((p) => p.length > 0);
    const amountPart = amountParts.length > 0 ? `；${amountParts.join('；')}` : '；用户未公开具体优惠金额';
    insights.push({
      text: `【用户讨论·优惠】${discountAsks.length}条买家评论询问优惠${amountPart}（用户说法，非门店政策）`,
      metric: discountAsks.length,
      evidence: [
        ...reported.slice(0, 2).map((d) => amountEvidence('discount', d)),
        ...hypothetical.slice(0, 1).map((d) => amountEvidence('discount', d)),
        ...[...discountAsks].sort(exampleOrder).slice(0, 3).map((q) => commentEvidence('user_discount_question', '用户讨论：问优惠', q.comment, questionQuote(q, ['discount']))),
      ],
    });
  }

  const budgets = questions
    .map((q) => ({ q, b: parseBudget(q.comment.content) }))
    .filter((x): x is { q: AnalyzedComment; b: NonNullable<ReturnType<typeof parseBudget>> } => x.b !== null);
  if (budgets.length > 0) {
    const lows = budgets.map((x) => x.b.budget_min ?? x.b.budget_max ?? 0).filter((n) => n > 0);
    const highs = budgets.map((x) => x.b.budget_max ?? x.b.budget_min ?? 0).filter((n) => n > 0);
    let range = '';
    if (lows.length > 0 && highs.length > 0) {
      const lo = Math.min(...lows);
      const hi = Math.max(...highs);
      range = lo === hi ? `，约${formatCny(lo)}` : `，范围${formatCny(lo)}–${formatCny(hi)}`;
    }
    insights.push({
      text: `【用户讨论·预算】${budgets.length}条买家提问自述了预算${range}`,
      metric: budgets.length,
      evidence: budgets.slice(0, 3).map((x) => commentEvidence('user_budget', `用户讨论：预算${x.b.quote}`, x.q.comment, clauseAround(x.q.comment.content, x.b.quote))),
    });
  }

  // ── dealer facts, and user talk vs dealer facts per model ───────────────────
  let offerCount = facts.general_offers.length;
  for (const model of scope.models) {
    const label = modelShortLabel(model);
    const offers = facts.offers_by_model.get(model) ?? [];
    offerCount += offers.length;
    if (offers.length > 0) {
      insights.push({
        text: `【门店事实·Dealer Brain】${label}当前有效政策：${offers.map((o) => describeOfferFact(o, tz)).join('；')}`,
        metric: offers.length,
        evidence: offers.map(offerEvidence),
      });
    }
    const modelAsks = localQuestions.filter((q) => modelOfItem(q, scope) === model && asks(q, PRICE_QUESTIONS));
    const awayAsks = awayQuestions.filter((q) => modelOfItem(q, scope) === model && asks(q, PRICE_QUESTIONS));
    const userDiscounts = discounts.filter((d) => d.model === model);
    const userLanding = landing.filter((l) => l.model === model);
    if (modelAsks.length === 0 && userDiscounts.length === 0 && userLanding.length === 0) continue;
    const userParts = [`${modelAsks.length}条买家评论问价/问优惠`];
    if (awayAsks.length > 0) userParts.push(`另有异地买家${awayAsks.length}条未计入`);
    if (userDiscounts.length > 0) userParts.push(`用户提到的优惠金额：${formatValues(userDiscounts.map((d) => d.value))}`);
    if (userLanding.length > 0) userParts.push(`用户提到的落地价：${formatValues(userLanding.map((l) => l.value))}`);
    const dealerPart =
      offers.length > 0
        ? `门店当前有效政策：${offers.map((o) => describeOfferFact(o, tz)).join('；')}（门店事实）`
        : '门店当前没有该车型的专项有效政策（门店事实）';
    insights.push({
      text: `【用户讨论 vs 门店事实】${label}：${userParts.join('；')}（用户说法）；${dealerPart}`,
      metric: modelAsks.length,
      evidence: [
        ...[...modelAsks].sort(exampleOrder).slice(0, 2).map((q) => commentEvidence('user_price_question', '用户讨论：问价/问优惠', q.comment, questionQuote(q, ['discount', 'landing_price', 'price']))),
        ...userDiscounts.slice(0, 2).map((d) => amountEvidence('discount', d)),
        ...userLanding.slice(0, 1).map((l) => amountEvidence('landing', l)),
        ...offers.slice(0, 2).map(offerEvidence),
      ],
    });
  }
  if (facts.general_offers.length > 0) {
    insights.push({
      text: `【门店事实·Dealer Brain】全车型通用政策：${facts.general_offers.map((o) => describeOfferFact(o, tz)).join('；')}`,
      metric: facts.general_offers.length,
      evidence: facts.general_offers.map(offerEvidence),
    });
  }

  // ── regional demand by IP 属地 ──────────────────────────────────────────────
  const byProvince = new Map<string, AnalyzedComment[]>();
  for (const q of questions) {
    const province = provinceOfIp(q.comment.ip_location);
    if (!province) continue;
    const list = byProvince.get(province) ?? [];
    list.push(q);
    byProvince.set(province, list);
  }
  const provinces = [...byProvince.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const withIp = provinces.reduce((s, [, l]) => s + l.length, 0);
  if (withIp > 0) {
    const home = byProvince.get(scope.dealer.province)?.length ?? 0;
    insights.push({
      text: `【区域需求·IP属地】买家提问IP属地分布：${provinces.map(([p, l]) => `${p}${l.length}`).join('、')}（本店所在${scope.dealer.province}占${pct(home, withIp)}%，${questions.length - withIp}条无IP属地）`,
      metric: pct(home, withIp),
      evidence: provinces.slice(0, 4).map(([p, l]) => {
        const best = [...l].sort(exampleOrder)[0];
        return commentEvidence('regional_demand', `IP属地：${p}`, best.comment, excerpt(best.comment.content));
      }),
    });
  }

  // ── inventory vs demand per model (buyers stating another region excluded) ─
  for (const model of scope.models) {
    const inv = facts.inventory_by_model.get(model) ?? { in_stock: 0, in_transit: 0, rows: [] };
    const demand = localQuestions.filter((q) => modelOfItem(q, scope) === model);
    const away = awayQuestions.filter((q) => modelOfItem(q, scope) === model);
    if (inv.in_stock + inv.in_transit === 0 && demand.length === 0 && away.length === 0) continue;
    const inventoryAsks = demand.filter((q) => q.analysis.detection.transaction_questions.some((t) => t === 'inventory' || t === 'color_trim_availability'));
    let flag = '';
    if (demand.length > 0 && inv.in_stock === 0) flag = inv.in_transit > 0 ? '：有需求但暂无现车，只有在途' : '：有需求但无现车也无在途';
    else if (demand.length === 0 && inv.in_stock > 0) flag = '：有现车但公开讨论中暂无本地买家需求信号';
    const places = [...new Set(away.map((q) => statedOutOfArea(q, scope)))].join('、');
    const awayPart = away.length > 0 ? `；另有异地买家${away.length}条（${places}）未计入` : '';
    const evidence: Evidence[] = [
      ...inv.rows.slice(0, 2).map((r) => ({ code: 'dealer_inventory', label: r.label, quote: r.trim, source_ref: `inventory:${r.id}` })),
      ...[...demand].sort(exampleOrder).slice(0, 2).map((q) => commentEvidence('user_demand', '用户讨论：需求信号', q.comment, excerpt(q.comment.content))),
    ];
    insights.push({
      text: `【门店库存 vs 用户需求】${modelShortLabel(model)}：门店现车${inv.in_stock}台、在途${inv.in_transit}台（门店事实）；近${days}天买家需求信号${demand.length}条，其中问现车/颜色${inventoryAsks.length}条（用户讨论）${awayPart}${flag}`,
      metric: demand.length,
      evidence,
    });
  }

  const prefix = simulationPrefix(corpus);
  const topProvince = provinces[0]?.[0];
  const headline =
    `${prefix}近${days}天价格与需求（${counts.posts}篇笔记、${counts.comments}条评论）：` +
    `用户讨论中${priceOrDiscountAsks.length}条买家评论问价/问优惠、自述落地价${reportedLanding.length}处；` +
    `门店事实：有效政策${offerCount}项（Dealer Brain）` +
    (topProvince ? `；买家IP属地以${topProvince}为主` : '') +
    `${dataBasisNote(corpus)}。`;
  return { headline, insights };
}

export async function runMarketResearch(ctx: AppContext, input: ResearchInput): Promise<ResearchBrief> {
  const scope = resolveScope(ctx, input);
  const queries = buildResearchQueries('market', scope);
  const corpus = await gatherResearchCorpus(ctx, scope, queries);
  const facts = loadMarketFacts(ctx, scope);
  const findings = analyzeMarketCorpus(corpus, scope, facts);
  return persistBrief(ctx, {
    kind: 'market',
    skill: SKILL_NAME,
    scope,
    corpus,
    findings,
    queries,
    extra_sources: facts.sources,
    extra_inputs: {
      dealer_facts: {
        offers: [...new Set([...[...facts.offers_by_model.values()].flat(), ...facts.general_offers].map((o) => o.id))],
        inventory: Object.fromEntries([...facts.inventory_by_model.entries()].map(([m, i]) => [m, { in_stock: i.in_stock, in_transit: i.in_transit }])),
      },
    },
  });
}

export const skill = defineSkill<ResearchInput, ResearchBrief>({
  name: SKILL_NAME,
  category: 'research',
  agent: 'research-agent',
  description:
    '汽车市场调研：区分“用户讨论”（公开落地价/优惠金额/预算，逐字引用，自述与提问/假设分开）与“门店事实”（Dealer Brain 有效政策与库存），按车型对照用户提到的优惠与门店政策，统计买家IP属地分布与本地买家需求对库存，保存调研简报。',
  input: researchInputValidator,
  run(ctx, input) {
    return runMarketResearch(ctx, input);
  },
  validateOutput: assertBriefShape,
});
