/**
 * Actor classification (ARCHITECTURE §10.2) — decides WHO wrote a public signal before it is scored.
 *
 * Buying intent is only credible from a prospective BUYER. Owners describing their car, creators writing guides,
 * dealer/sales accounts soliciting and enthusiasts discussing automotive knowledge all use purchase vocabulary
 * (落地价, 优惠, 现车 …) without being in the market; they must never become acquisition leads.
 *
 * Pure: derives the class from the rules engine's IntentDetection (author_role, is_marketing, evidence codes,
 * purchase-signal flag) and optionally the prefilter result. First matching rule wins.
 */
import type { ActorType, Evidence, IntentDetection, PrefilterResult } from '../core/types.ts';

export const ACTOR_LABELS: Readonly<Record<ActorType, string>> = {
  BUYER: '潜在买家',
  OWNER: '车主',
  CREATOR: '内容创作者',
  DEALER_OR_SALES: '车商/销售',
  ENTHUSIAST: '汽车爱好者',
  UNKNOWN: '未识别',
};

/** Evidence codes the prefilter emits when a text is rejected before intent analysis. */
const PREFILTER_REJECT_CODES = new Set(['empty_or_emoji', 'pure_praise', 'marketing_account', 'too_short', 'no_signal']);
const MARKETING_CODES = new Set(['marketing_account', 'industry_account']);

export interface ActorClassification {
  actor_type: ActorType;
  /** Chinese explanation shown to salespeople */
  reason: string;
  /** evidence code that decided the class, when one did */
  evidence_code: string | null;
}

const hasCode = (evidence: readonly Evidence[], codes: Set<string> | string): Evidence | undefined =>
  evidence.find((e) => (typeof codes === 'string' ? e.code === codes : codes.has(e.code)));

const quoted = (e: Evidence | undefined): string => (e?.quote ? `：“${e.quote}”` : '');

export function classifyActor(detection: IntentDetection, prefilter?: PrefilterResult | null): ActorClassification {
  const evidence = detection.evidence ?? [];

  const marketing = hasCode(evidence, MARKETING_CODES);
  if (detection.is_marketing || detection.author_role === 'marketing' || prefilter?.is_marketing || marketing) {
    return {
      actor_type: 'DEALER_OR_SALES',
      reason: `营销/车商/销售账号话术${quoted(marketing)}`,
      evidence_code: marketing?.code ?? 'marketing_account',
    };
  }

  const owner = hasCode(evidence, 'already_purchased');
  if (detection.author_role === 'owner' || (owner && !detection.is_purchase_signal)) {
    return { actor_type: 'OWNER', reason: `已购车车主，非在市买家${quoted(owner)}`, evidence_code: owner?.code ?? 'already_purchased' };
  }

  const creator = hasCode(evidence, 'content_creator');
  if (detection.author_role === 'creator' || creator) {
    return { actor_type: 'CREATOR', reason: `内容创作者/攻略测评类内容${quoted(creator)}`, evidence_code: creator?.code ?? 'content_creator' };
  }

  if (detection.is_purchase_signal) {
    const top = evidence.find((e) => !PREFILTER_REJECT_CODES.has(e.code));
    return { actor_type: 'BUYER', reason: `表达了购车需求${quoted(top)}`, evidence_code: top?.code ?? null };
  }

  const rejected = prefilter ? !prefilter.passed : evidence.some((e) => PREFILTER_REJECT_CODES.has(e.code));
  if (!rejected && !detection.negative) {
    const topic = evidence[0];
    return { actor_type: 'ENTHUSIAST', reason: `讨论汽车话题但没有购车意向${quoted(topic)}`, evidence_code: topic?.code ?? null };
  }

  const why = hasCode(evidence, PREFILTER_REJECT_CODES) ?? hasCode(evidence, 'not_interested');
  return { actor_type: 'UNKNOWN', reason: why ? `${why.label}${quoted(why)}` : '信息不足，无法判断身份', evidence_code: why?.code ?? null };
}

/**
 * Lead-level actor: DEALER_OR_SALES when lead research found an industry account; BUYER as soon as any signal is a
 * BUYER signal; otherwise the most recent classified signal; UNKNOWN when nothing is classified.
 * `signalTypes` must be ordered oldest → newest.
 */
export function aggregateActorType(
  signalTypes: readonly (ActorType | null | undefined)[],
  opts: { industry_account?: boolean } = {},
): ActorType {
  if (opts.industry_account) return 'DEALER_OR_SALES';
  if (signalTypes.includes('BUYER')) return 'BUYER';
  for (let i = signalTypes.length - 1; i >= 0; i--) {
    const t = signalTypes[i];
    if (t) return t;
  }
  return 'UNKNOWN';
}
