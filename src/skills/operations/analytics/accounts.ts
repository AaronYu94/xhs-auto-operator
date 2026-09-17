/**
 * Account fleet analytics: health attention list for the dashboard and the per-account overview table.
 * Read-only — personas and health snapshots are read as stored (never created here).
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import type { HealthState, XhsAccount } from '../../../core/types.ts';
import { getAccountPerformance } from '../account-brain/index.ts';
import { getLatestHealth } from '../account-health/index.ts';
import { getDealer } from '../dealer-brain/index.ts';
import type { NormalizedFilters } from './filters.ts';
import type { AccountAttention, AccountOverviewRow } from './types.ts';

/** Issue reported for an account that has never had a health snapshot computed. */
export const HEALTH_NOT_COMPUTED_ISSUE = '尚未计算健康度';

const ACCOUNT_ORDER = 'dealer_id ASC, created_at ASC, nickname ASC';

/** Attention ordering: most severe first; accounts never evaluated rank above WATCH. */
const ATTENTION_RANK: Record<HealthState | 'NONE', number> = { RESTRICTED: 0, AT_RISK: 1, NONE: 2, WATCH: 3, HEALTHY: 4 };

/** Accounts matching dealer/account filters (both must hold when both are given). */
export function accountsInScope(ctx: AppContext, n: NormalizedFilters): XhsAccount[] {
  const where: { id?: string; dealer_id?: string } = {};
  if (n.account_id !== undefined) where.id = n.account_id;
  if (n.dealer_id !== undefined) where.dealer_id = n.dealer_id;
  return ctx.db.table('xhs_accounts').findMany(where, { orderBy: ACCOUNT_ORDER });
}

/** active = status 'active'; healthy = latest snapshot HEALTHY; everything else (incl. no snapshot) needs attention. */
export function summarizeAccounts(
  ctx: AppContext,
  accounts: readonly XhsAccount[],
): { active: number; healthy: number; requiring_attention: AccountAttention[] } {
  let active = 0;
  let healthy = 0;
  const attention: (AccountAttention & { order: number })[] = [];
  accounts.forEach((account, order) => {
    if (account.status === 'active') active++;
    const health = getLatestHealth(ctx, account.id);
    if (!health) {
      attention.push({ account_id: account.id, nickname: account.nickname, state: null, issues: [HEALTH_NOT_COMPUTED_ISSUE], order });
    } else if (health.state === 'HEALTHY') {
      healthy++;
    } else {
      attention.push({ account_id: account.id, nickname: account.nickname, state: health.state, issues: [...(health.issues ?? [])], order });
    }
  });
  attention.sort((a, b) => ATTENTION_RANK[a.state ?? 'NONE'] - ATTENTION_RANK[b.state ?? 'NONE'] || a.order - b.order);
  return {
    active,
    healthy,
    requiring_attention: attention.map(({ order: _order, ...item }) => item),
  };
}

/**
 * Per-account overview (optionally one dealer): persona, focus models, latest health and real 30/90-day
 * performance from Account Brain (`getAccountPerformance`).
 */
export function getAccountsOverview(ctx: AppContext, dealerId?: string): AccountOverviewRow[] {
  const raw: unknown = dealerId;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new ValidationError('dealer_id', 'expected string');
  const id = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  if (id !== undefined) getDealer(ctx, id);

  const accounts = ctx.db.table('xhs_accounts').findMany(id !== undefined ? { dealer_id: id } : {}, { orderBy: ACCOUNT_ORDER });
  return accounts.map((account) => {
    const persona = ctx.db.table('account_personas').findOne({ account_id: account.id });
    const health = getLatestHealth(ctx, account.id);
    const perf = getAccountPerformance(ctx, account.id);
    return {
      account_id: account.id,
      dealer_id: account.dealer_id,
      nickname: account.nickname,
      account_type: account.account_type,
      status: account.status,
      auth_state: account.auth_state,
      persona_name: persona?.persona_name ?? null,
      focus_models: [...(persona?.focus_models ?? [])],
      health_state: health?.state ?? null,
      health_score: health?.health_score ?? null,
      health_issues: health ? [...(health.issues ?? [])] : [HEALTH_NOT_COMPUTED_ISSUE],
      health_date: health?.date ?? null,
      active_leads: perf.leads_owned_active,
      outreach_sent_30d: perf.outreach_sent_30d,
      reply_rate_30d: perf.reply_rate_30d,
      appointments_90d: perf.appointments_90d,
      won_90d: perf.won_90d,
      posts_published_30d: perf.posts_published_30d,
    };
  });
}
