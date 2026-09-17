/**
 * Sales funnel (spec §14): current count per stage and stage-to-stage conversion over the non-LOST chain.
 */
import type { AppContext } from '../../../app/context.ts';
import { round } from '../../../core/text.ts';
import { LEAD_STAGES, type LeadStage } from '../../../core/types.ts';
import { STAGE_INDEX } from '../crm/index.ts';
import { joinAnd, leadScope, normalizeFilters, num, type SqlFragment } from './filters.ts';
import type { AnalyticsFilters, FunnelStage } from './types.ts';

/**
 * Every LEAD_STAGES entry in funnel order. `reached(X)` = leads currently at X or deeper excluding LOST (WON is the
 * deepest); `conversion_from_prev = reached(X) / reached(previous)` (0 when the denominator is 0). DISCOVERED is 1
 * when any non-LOST lead exists. LOST reports its count with conversion 0 (it is not part of the chain).
 * Explicit `from`/`to` restrict the cohort to leads first seen in that window.
 */
export function getFunnel(ctx: AppContext, f: AnalyticsFilters = {}): FunnelStage[] {
  const n = normalizeFilters(ctx, f);
  const parts: SqlFragment[] = [leadScope(n, 'l')];
  if (n.from !== undefined) parts.push({ sql: 'l.first_seen_at >= ?', params: [n.from] });
  if (n.to !== undefined) parts.push({ sql: 'l.first_seen_at < ?', params: [n.to] });
  const where = joinAnd(parts);
  const rows = ctx.db.all(`SELECT l.stage AS stage, COUNT(*) AS n FROM leads l WHERE ${where.sql} GROUP BY l.stage`, ...where.params);
  const counts = new Map<LeadStage, number>();
  for (const row of rows) counts.set(row.stage as LeadStage, num(row, 'n'));
  const countOf = (stage: LeadStage) => counts.get(stage) ?? 0;

  const chain = LEAD_STAGES.filter((s) => s !== 'LOST');
  const reached = (stage: LeadStage) =>
    chain.filter((s) => STAGE_INDEX[s] >= STAGE_INDEX[stage]).reduce((sum, s) => sum + countOf(s), 0);

  return LEAD_STAGES.map((stage) => {
    if (stage === 'LOST') return { stage, count: countOf(stage), reached: countOf(stage), conversion_from_prev: 0 };
    const i = chain.indexOf(stage);
    const here = reached(stage);
    let conversion: number;
    if (i === 0) conversion = here > 0 ? 1 : 0;
    else {
      const prev = reached(chain[i - 1]);
      conversion = prev > 0 ? round(here / prev, 4) : 0;
    }
    return { stage, count: countOf(stage), reached: here, conversion_from_prev: conversion };
  });
}
