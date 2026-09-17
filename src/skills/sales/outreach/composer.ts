/**
 * Deterministic, persona-aware outreach composer (spec §12).
 *
 * Every message is built from (a) the user's REAL public signal — a short verbatim quote of the primary signal or
 * the post it was written under — and (b) Dealer Brain facts retrieved through answerFact, embedded verbatim so each
 * factual phrase is backed by a FactRef. Nothing about price, stock or offers is ever written from templates.
 * The five account types speak in clearly different voices; contact exchange is steered to 留资卡 / 预约到店
 * (no phone, WeChat or links — Xiaohongshu rule since 2025-01-07).
 */
import type { AppContext } from '../../../app/context.ts';
import type {
  AccountPersona,
  Dealer,
  Evidence,
  FactRef,
  Lead,
  LeadSignal,
  Offer,
  OfferType,
  OutreachKind,
  Vehicle,
  XhsAccount,
} from '../../../core/types.ts';
import { checkPlatformRules, detectContactInfoLeak } from '../../operations/compliance/index.ts';
import {
  answerFact,
  extractClaims,
  getProhibitedClaims,
  resolveVehicle,
  vehicleDisplayName,
  type FactAnswer,
} from '../../operations/dealer-brain/index.ts';

export const MAX_OUTREACH_CHARS = 300;
export const MAX_QUOTE_CHARS = 18;

const COLOUR = '白黑灰蓝红棕银绿金紫橙黄米咖青粉';
const COLOUR_PAIR_RE = new RegExp(`([${COLOUR}])色?外(?:观|饰)?[、,，\\s]*([${COLOUR}])色?内`, 'u');
const COLOUR_SINGLE_RE = new RegExp(`([${COLOUR}])色|^([${COLOUR}])$`, 'u');
const CLAUSE_SPLIT_RE = /[，。！？!?,；;\n]+/u;
const QUOTE_PRIORITY_RE = /落地|优惠|现车|价|多少|贷款|分期|首付|置换|试驾|看车|提车|库存|车源|哪家|推荐|值得|怎么样|还是|对比|预算/u;
const TRANSACTIONAL_STAGES = new Set(['price_shopping', 'active_shopping', 'dealer_selection', 'purchase_imminent']);

export interface ComposeInput {
  lead: Lead;
  account: XhsAccount;
  persona: AccountPersona | null;
  /** the dealer whose facts are quoted (the sending account's store) */
  dealer: Dealer;
  signal: LeadSignal | null;
  kind: OutreachKind;
  /** for follow-ups: the last touch that went out */
  previous_touch?: { sent_at: string | null } | null;
}

export interface ComposedOutreach {
  message: string;
  fact_refs: FactRef[];
  personalization: Evidence[];
  /** verbatim quote of the user's signal used in the message, if any */
  quote: string | null;
  facts_used: { kind: string; text: string }[];
}

interface FactPhrase {
  kind: 'inventory' | 'offer' | 'highlight';
  text: string;
  refs: FactRef[];
  /** lower = dropped first when the message is too long */
  priority: number;
}

export function parseColourIntent(text: string | undefined | null): { exterior?: string; interior?: string } {
  if (!text) return {};
  const pair = COLOUR_PAIR_RE.exec(text);
  if (pair) return { exterior: pair[1], interior: pair[2] };
  const single = COLOUR_SINGLE_RE.exec(text);
  const c = single?.[1] ?? single?.[2];
  return c ? { exterior: c } : {};
}

const chars = (s: string) => Array.from(s);
const clip = (s: string, max: number) => chars(s).slice(0, max).join('');

/**
 * A short verbatim quote of the user's own words that is safe to repeat back: no contact details, no prohibited
 * or ad-law phrases, and no fragment that would read as a factual claim (price / stock / rate) in OUR message.
 */
export function pickSignalQuote(
  content: string | null | undefined,
  prohibited: { phrase: string; reason: string }[],
  max = MAX_QUOTE_CHARS,
): string | null {
  if (!content) return null;
  const clauses = content
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter((c) => chars(c).length >= 2);
  const ordered = [...clauses.filter((c) => QUOTE_PRIORITY_RE.test(c)), ...clauses.filter((c) => !QUOTE_PRIORITY_RE.test(c))];
  for (const clause of ordered) {
    const candidate = chars(clause).length > max ? clip(clause, max) : clause;
    if (!content.includes(candidate)) continue;
    if (detectContactInfoLeak(candidate).length > 0) continue;
    if (!checkPlatformRules(candidate, { prohibited, max_length: MAX_OUTREACH_CHARS, channel: 'dm' }).passed) continue;
    if (extractClaims(`问“${candidate}”，`).length > 0) continue;
    return candidate;
  }
  return null;
}

function refsFor(answer: FactAnswer, claim: string): FactRef[] {
  return answer.facts.filter((f) => f.claim === claim);
}

function inventoryPhrase(ctx: AppContext, dealer: Dealer, lead: Lead, vehicle: Vehicle, label: string): FactPhrase | null {
  const intent = lead.intent ?? {};
  const wants =
    intent.inventory_intent === true ||
    Boolean(intent.color_intent) ||
    (Boolean(intent.trim) && TRANSACTIONAL_STAGES.has(intent.purchase_stage ?? ''));
  if (!wants) return null;
  const trim = intent.trim ? vehicle.trim : undefined;
  const colours = parseColourIntent(intent.color_intent);
  const pick = (answer: FactAnswer): string | null => {
    const claims = [...new Set(answer.facts.map((f) => f.claim))];
    return claims.find((c) => c.includes('现车')) ?? claims[0] ?? null;
  };
  if (colours.exterior) {
    const exact = answerFact(ctx, dealer.id, { kind: 'inventory', model: vehicle.model, trim, exterior_color: colours.exterior, interior_color: colours.interior });
    const claim = exact.found ? pick(exact) : null;
    if (claim) return { kind: 'inventory', text: `店里${label}目前有${claim}。`, refs: refsFor(exact, claim), priority: 5 };
  }
  const any = answerFact(ctx, dealer.id, { kind: 'inventory', model: vehicle.model, trim });
  const claim = any.found ? pick(any) : null;
  if (claim) {
    const lead_in = colours.exterior ? '您问的配色我再帮您确认，' : '';
    return { kind: 'inventory', text: `${lead_in}店里${label}目前有${claim}。`, refs: refsFor(any, claim), priority: 5 };
  }
  return { kind: 'inventory', text: `${label}的车源我这边再帮您逐台确认。`, refs: [], priority: 4 };
}

function offerPhrase(ctx: AppContext, dealer: Dealer, lead: Lead, vehicle: Vehicle): FactPhrase | null {
  const intent = lead.intent ?? {};
  const wants =
    intent.price_intent === true ||
    intent.discount_intent === true ||
    intent.financing_intent === true ||
    intent.leasing_intent === true ||
    intent.trade_in_intent === true ||
    TRANSACTIONAL_STAGES.has(intent.purchase_stage ?? '');
  if (!wants) return null;
  const trim = intent.trim ? vehicle.trim : undefined;
  let kind: 'finance' | 'lease' | 'trade_in' | 'offer' = 'offer';
  let preferred: OfferType[] = ['cash_discount'];
  if (intent.financing_intent) [kind, preferred] = ['finance', ['finance']];
  else if (intent.leasing_intent) [kind, preferred] = ['lease', ['lease']];
  else if (intent.trade_in_intent) [kind, preferred] = ['trade_in', ['trade_in']];
  let answer = answerFact(ctx, dealer.id, { kind, model: vehicle.model, trim });
  let programNote = '';
  if (!answer.found && kind !== 'offer') {
    const label = kind === 'finance' ? '贷款方案' : kind === 'lease' ? '以租代购方案' : '置换补贴';
    programNote = `${label}目前需要到店由专员结合您的情况单独评估，`;
    answer = answerFact(ctx, dealer.id, { kind: 'offer', model: vehicle.model, trim });
  }
  if (!answer.found) return programNote ? { kind: 'offer', text: `${programNote.replace(/，$/u, '')}。`, refs: [], priority: 3 } : null;

  const offerIds = [...new Set(answer.facts.filter((f) => f.kind === 'offer').map((f) => f.id))];
  const offers = offerIds.map((id) => ctx.db.table('offers').get(id)).filter((o): o is Offer => Boolean(o));
  if (offers.length === 0) return null;
  offers.sort(
    (a, b) =>
      Number(preferred.includes(b.type)) - Number(preferred.includes(a.type)) ||
      Number(b.type === 'cash_discount') - Number(a.type === 'cash_discount') ||
      (b.amount ?? 0) - (a.amount ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const offer = offers[0];
  const refs = answer.facts.filter((f) => f.kind === 'offer' && f.id === offer.id);
  if (refs.length === 0) return null;
  const claims = refs.map((r) => r.claim);
  return {
    kind: 'offer',
    text: `${programNote}本店现在有「${offer.title}」：${claims.join('，')}，具体以门店书面报价为准。`,
    refs,
    priority: 3,
  };
}

function highlightPhrase(ctx: AppContext, dealer: Dealer, lead: Lead, vehicle: Vehicle, label: string): FactPhrase | null {
  const answer = answerFact(ctx, dealer.id, { kind: 'highlights', model: vehicle.model, trim: lead.intent?.trim ? vehicle.trim : undefined });
  if (!answer.found) return null;
  const ref = answer.facts.find((f) => f.id === vehicle.id) ?? answer.facts[0];
  if (!ref) return null;
  return { kind: 'highlight', text: `${label}有一点值得关注：${ref.claim}。`, refs: [ref], priority: 2 };
}

function nameOf(account: XhsAccount, persona: AccountPersona | null): string {
  return account.salesperson_name?.trim() || persona?.persona_name?.trim() || account.nickname;
}

function signature(persona: AccountPersona | null, prohibited: { phrase: string; reason: string }[]): string | null {
  for (const s of persona?.signature_phrases ?? []) {
    const t = s.trim();
    if (!t || /评论区|私信|主页|关注|加|扫/u.test(t)) continue;
    if (extractClaims(t).length > 0) continue;
    if (!checkPlatformRules(t, { prohibited, max_length: 60, channel: 'dm' }).passed) continue;
    return t;
  }
  return null;
}

interface Part {
  text: string;
  /** optional parts are dropped (lowest priority first) when the message exceeds MAX_OUTREACH_CHARS */
  priority: number | null;
  refs?: FactRef[];
}

function assemble(parts: Part[]): { message: string; refs: FactRef[] } {
  let active = parts.filter((p) => p.text);
  const length = () => chars(active.map((p) => p.text).join('')).length;
  while (length() > MAX_OUTREACH_CHARS) {
    const droppable = active.filter((p) => p.priority !== null).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    if (droppable.length === 0) break;
    active = active.filter((p) => p !== droppable[0]);
  }
  const message = active.map((p) => p.text).join('');
  const refs: FactRef[] = [];
  const seen = new Set<string>();
  for (const p of active) {
    for (const r of p.refs ?? []) {
      const key = `${r.kind}:${r.id}:${r.claim}`;
      if (seen.has(key) || !message.includes(r.claim)) continue;
      seen.add(key);
      refs.push(r);
    }
  }
  return { message: chars(message).length > MAX_OUTREACH_CHARS ? clip(message, MAX_OUTREACH_CHARS) : message, refs };
}

/** Compose the outreach text for one lead from the sending account's point of view. */
export function composeOutreachMessage(ctx: AppContext, input: ComposeInput): ComposedOutreach {
  const { lead, account, persona, dealer, signal, kind } = input;
  const intent = lead.intent ?? {};
  const prohibited = getProhibitedClaims(ctx, dealer.id).map((p) => ({ phrase: p.phrase, reason: p.reason }));
  const personalization: Evidence[] = [];

  const vehicle = intent.model
    ? resolveVehicle(ctx, dealer.group_id, { brand: intent.brand, model: intent.model, trim: intent.trim })
    : null;
  const label = vehicle ? (intent.trim ? vehicleDisplayName(vehicle) : `${vehicle.brand_zh}${vehicle.model_zh}`) : null;
  const brandZh = vehicle?.brand_zh ?? '';
  if (label) personalization.push({ code: 'requested_vehicle', label: `关注车型 ${label}`, source_ref: lead.id });

  // ── the user's real public signal ────────────────────────────────────────
  const title = signal?.post_title?.trim() || null;
  let quote: string | null = null;
  let signalRef = '';
  if (signal) {
    quote = pickSignalQuote(signal.content, prohibited);
    const shortTitle = title ? clip(title.replace(/[《》]/gu, ''), 16) : null;
    if (quote && signal.source_type === 'comment' && shortTitle) signalRef = `看到您在《${shortTitle}》下问“${quote}”，`;
    else if (quote && signal.source_type === 'post') signalRef = `看到您发的笔记里提到“${quote}”，`;
    else if (quote) signalRef = `看到您在小红书上提到“${quote}”，`;
    else if (shortTitle) signalRef = `看到您在《${shortTitle}》下的留言，`;
    if (quote) personalization.push({ code: 'public_signal', label: '引用客户公开信号', quote, source_ref: signal.id });
    else if (shortTitle) personalization.push({ code: 'public_signal_post', label: '引用客户留言所在笔记', quote: shortTitle, source_ref: signal.id });
  }
  if (!signalRef) signalRef = label ? `看到您在小红书上关注${label}，` : '看到您在小红书上在看车，';

  const local = intent.location && intent.location === dealer.city ? `您也在${dealer.city}，` : '';
  if (local) personalization.push({ code: 'local_buyer', label: `本地买家（${dealer.city}）`, source_ref: lead.id });

  // ── Dealer Brain facts (verbatim claims) ─────────────────────────────────
  const facts: FactPhrase[] = [];
  if (vehicle && label) {
    const inv = inventoryPhrase(ctx, dealer, lead, vehicle, label);
    if (inv) facts.push(inv);
    const offer = offerPhrase(ctx, dealer, lead, vehicle);
    if (offer) facts.push(offer);
    if (facts.length === 0 || (account.account_type === 'model_specialist' && !facts.some((f) => f.kind === 'inventory'))) {
      const hl = highlightPhrase(ctx, dealer, lead, vehicle, label);
      if (hl) facts.push(hl);
    }
  }
  for (const f of facts) {
    if (f.refs.length > 0) personalization.push({ code: `${f.kind}_fact`, label: `引用门店数据：${f.refs.map((r) => r.claim).join('、')}`, source_ref: f.refs[0].id });
  }

  const name = nameOf(account, persona);
  const sig = signature(persona, prohibited);
  const factParts: Part[] = facts.map((f) => ({ text: f.text, priority: f.priority, refs: f.refs }));
  const focus = (persona?.focus_models ?? []).slice(0, 2).join('、') || label || '新车';
  const city = account.city || dealer.city;
  const hasStock = facts.some((f) => f.kind === 'inventory' && f.refs.length > 0);

  const parts: Part[] = [];
  if (kind === 'follow_up') {
    const days = input.previous_touch?.sent_at
      ? Math.max(1, Math.round((ctx.clock.now().getTime() - Date.parse(input.previous_touch.sent_at)) / 86_400_000))
      : null;
    const when = days ? `${days}天前` : '之前';
    const intro =
      account.account_type === 'official'
        ? `您好，这里是${dealer.name}官方账号，`
        : account.account_type === 'salesperson'
          ? `您好，我是${dealer.name}的${name}，`
          : `你好，我是「${account.nickname}」，`;
    parts.push({ text: `${intro}${when}跟您聊过${label ?? '选车'}的事，不知道您最近考虑得怎么样？`, priority: null });
    const offer = facts.find((f) => f.kind === 'offer');
    if (offer) parts.push({ text: offer.text, priority: offer.priority, refs: offer.refs });
    parts.push({ text: '有需要随时回复我；如果暂时不考虑，回我一句就不再打扰。', priority: null });
    const built = assemble(parts);
    return {
      message: built.message,
      fact_refs: built.refs,
      personalization: [...personalization, { code: 'previous_touch', label: `跟进${when}的首次私信`, source_ref: lead.id }],
      quote: null,
      facts_used: facts.filter((f) => f.kind === 'offer').map((f) => ({ kind: f.kind, text: f.text })),
    };
  }

  switch (account.account_type) {
    case 'official':
      parts.push({ text: `您好，这里是${dealer.name}官方账号。`, priority: null });
      parts.push({ text: signalRef, priority: null });
      parts.push({ text: local, priority: 1 });
      parts.push(...factParts);
      parts.push({ text: `如需进一步了解，可以通过留资卡预约到店，我们安排顾问为您详细介绍。`, priority: null });
      break;
    case 'salesperson':
      parts.push({ text: `您好，我是${dealer.name}的销售顾问${name}。`, priority: null });
      parts.push({ text: signalRef, priority: null });
      parts.push({ text: local, priority: 1 });
      parts.push(...factParts);
      parts.push({
        text: hasStock ? '不催单，您可以先对比看看，方便的话用留资卡约个时间到店看实车。' : '不催单，您可以先对比看看，方便的话用留资卡约个时间，我帮您把问题一次讲清楚。',
        priority: null,
      });
      if (sig) parts.push({ text: sig, priority: 0 });
      break;
    case 'model_specialist':
      parts.push({ text: `你好，我是「${account.nickname}」，平时专注${focus}的实测研究。`, priority: null });
      parts.push({ text: signalRef, priority: null });
      parts.push(...factParts);
      parts.push({ text: `参数之外更建议亲自开一次，可以通过留资卡预约${dealer.name}的试驾，把关心的点一次看清楚。`, priority: null });
      if (sig) parts.push({ text: sig, priority: 0 });
      break;
    case 'local_guide':
      parts.push({ text: `哈喽，我是「${account.nickname}」，专门整理${city}本地买车攻略。`, priority: null });
      parts.push({ text: signalRef, priority: null });
      parts.push({ text: local, priority: 1 });
      parts.push(...factParts);
      parts.push({ text: `到店前建议先把想看的配置列好，想去${dealer.name}看车可以用留资卡预约一下，少跑冤枉路。`, priority: null });
      if (sig) parts.push({ text: sig, priority: 0 });
      break;
    case 'customer_story':
      parts.push({ text: `你好，我是「${account.nickname}」，平时记录${brandZh}车主的真实用车故事。`, priority: null });
      parts.push({ text: signalRef, priority: null });
      parts.push(...factParts);
      parts.push({ text: `选车时多听听真实车主的感受会更踏实，也欢迎通过留资卡预约到${dealer.name}试驾亲自感受。`, priority: null });
      if (sig) parts.push({ text: sig, priority: 0 });
      break;
  }
  const built = assemble(parts);
  const kept = facts.filter((f) => f.refs.length === 0 || f.refs.some((r) => built.message.includes(r.claim)));
  return {
    message: built.message,
    fact_refs: built.refs,
    personalization: personalization.filter((e) => !e.quote || e.code !== 'public_signal' || built.message.includes(e.quote)),
    quote: quote && built.message.includes(quote) ? quote : null,
    facts_used: kept.map((f) => ({ kind: f.kind, text: f.text })),
  };
}
