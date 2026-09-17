/**
 * Group-level signal evaluation for discovery (ARCHITECTURE §5.3): a public signal is analysed and scored against
 * EVERY dealer profile of the query dealer's group; the lead is routed to the dealer with the highest signal score
 * (ties → the query's dealer, then group order).
 *
 * Thin adapter over lead-scoring's `evaluateSignalForDealers` / `listGroupDealerIds` (single source of truth for
 * author roles, the out-of-area cap and dealer-timezone-relative timeframes). What it adds for discovery: the cheap
 * prefilter gate (deeper analysis is never spent on noise) and a per-ingest cache of the dealers' scoring configs.
 */
import type { AppContext } from '../../../app/context.ts';
import type { PrefilterResult, ScoringConfig, SignalContext } from '../../../core/types.ts';
import {
  evaluateSignalForDealers,
  getScoringConfig,
  listGroupDealerIds,
  type DealerSignalEvaluation,
} from '../lead-scoring/index.ts';

export type DealerSignalResult = DealerSignalEvaluation;

/** All dealers of the given dealer's group, the given dealer first. */
export function groupDealerIds(ctx: AppContext, dealerId: string): string[] {
  return listGroupDealerIds(ctx, dealerId);
}

export class GroupEvaluator {
  private readonly ctx: AppContext;
  readonly dealerIds: readonly string[];
  private readonly configs = new Map<string, ScoringConfig>();

  constructor(ctx: AppContext, dealerIds: readonly string[]) {
    if (dealerIds.length === 0) throw new Error('GroupEvaluator needs at least one dealer');
    this.ctx = ctx;
    this.dealerIds = dealerIds;
  }

  config(dealerId: string): ScoringConfig {
    let cfg = this.configs.get(dealerId);
    if (!cfg) {
      cfg = getScoringConfig(this.ctx, dealerId);
      this.configs.set(dealerId, cfg);
    }
    return cfg;
  }

  /**
   * Evaluate a text that already passed the cheap prefilter against every group dealer. Returns every dealer's
   * result and the best one; `null` when the prefilter rejected the text.
   */
  evaluate(
    text: string,
    context: SignalContext,
    signalAt: string,
    prefilterResult: PrefilterResult,
    preferredDealerId: string,
  ): { results: DealerSignalResult[]; best: DealerSignalResult } | null {
    if (!prefilterResult.passed) return null;
    return evaluateSignalForDealers(this.ctx, {
      dealer_ids: [...this.dealerIds],
      text,
      context,
      signal_at: signalAt,
      preferred_dealer_id: preferredDealerId,
    });
  }
}
