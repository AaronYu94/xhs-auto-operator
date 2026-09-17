/**
 * Account Health (spec §24): daily per-account risk snapshot used by the Fleet Controller and the
 * pre-send `account_health` guard. Deterministic rules; every computation is an audited decision.
 */
import type { AppContext } from '../../../app/context.ts';
import { newId } from '../../../core/ids.ts';
import { clamp, round } from '../../../core/text.ts';
import { addDaysToKey, localDateKey, zonedTimeToUtc } from '../../../core/time.ts';
import type { AccountHealth, AccountStatus, AuthState, Evidence, HealthState } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import {
  effectiveOutreachPolicy,
  effectivePublishPolicy,
  getAccountPerformance,
  requireAccount,
  type AccountPerformance,
} from '../account-brain/index.ts';
import { getDealer } from '../dealer-brain/index.ts';

/** Inclusive score band per state (health_score is always inside its state's band). */
export const HEALTH_SCORE_BANDS: Record<HealthState, { min: number; max: number }> = {
  HEALTHY: { min: 80, max: 100 },
  WATCH: { min: 60, max: 79 },
  AT_RISK: { min: 30, max: 59 },
  RESTRICTED: { min: 0, max: 29 },
};

export interface HealthInputs {
  status: AccountStatus;
  auth_state: AuthState;
  outreach_sent_today: number;
  daily_outreach_limit: number;
  publish_today: number;
  daily_publish_limit: number;
  negative_feedback_7d: number;
  reply_rate_30d: number;
  outreach_sent_30d: number;
}

export interface HealthEvaluation {
  state: HealthState;
  health_score: number;
  findings: Evidence[];
}

/** Pure state machine for account health (see SKILL.md for the rule table). */
export function evaluateAccountHealth(i: HealthInputs): HealthEvaluation {
  const findings: Evidence[] = [];
  let restricted = false;
  let atRisk = false;
  let watch = false;
  let penalty = 0;

  if (i.status === 'disabled') {
    restricted = true;
    penalty += 80;
    findings.push({ code: 'account_disabled', label: '账号已停用，禁止发布与私信等一切操作' });
  }
  if (i.auth_state === 'requires_auth') {
    atRisk = true;
    penalty += 30;
    findings.push({ code: 'requires_auth', label: '账号登录授权已失效，需要重新授权后才能执行平台操作' });
  }
  if (i.negative_feedback_7d >= 3) {
    atRisk = true;
    penalty += Math.min(40, 20 + 5 * (i.negative_feedback_7d - 3));
    findings.push({
      code: 'negative_feedback_high',
      label: `近7天有${i.negative_feedback_7d}位被联系用户明确拒绝联系，需暂停主动触达并复盘话术`,
    });
  } else if (i.negative_feedback_7d >= 1) {
    watch = true;
    penalty += 8 * i.negative_feedback_7d;
    findings.push({ code: 'negative_feedback', label: `近7天有${i.negative_feedback_7d}位被联系用户拒绝联系` });
  }

  const limit = i.daily_outreach_limit;
  const limitReached = limit > 0 ? i.outreach_sent_today >= limit : i.outreach_sent_today > 0;
  if (limitReached) {
    atRisk = true;
    penalty += 25;
    findings.push({
      code: 'outreach_limit_reached',
      label: `今日私信已达上限（${i.outreach_sent_today}/${limit}），今天不再发送`,
    });
  } else if (limit > 0 && i.outreach_sent_today >= 0.8 * limit) {
    watch = true;
    penalty += 10;
    findings.push({ code: 'outreach_limit_near', label: `今日私信接近上限（${i.outreach_sent_today}/${limit}）` });
  }

  if (i.status === 'paused') {
    watch = true;
    penalty += 15;
    findings.push({ code: 'account_paused', label: '账号已暂停运营' });
  } else if (i.status === 'cooldown') {
    watch = true;
    penalty += 15;
    findings.push({ code: 'account_cooldown', label: '账号处于冷却期，暂缓主动触达' });
  }

  if (i.outreach_sent_30d >= 10 && i.reply_rate_30d < 0.05) {
    watch = true;
    penalty += 12;
    findings.push({
      code: 'low_reply_rate',
      label: `近30天私信回复率偏低（${round(i.reply_rate_30d * 100, 1)}%，共发送${i.outreach_sent_30d}条），需优化话术与目标人群`,
    });
  }

  if (i.daily_publish_limit > 0 && i.publish_today >= i.daily_publish_limit) {
    penalty += 3;
    findings.push({
      code: 'publish_limit_reached',
      label: `今日发布已达上限（${i.publish_today}/${i.daily_publish_limit}）`,
    });
  }

  const state: HealthState = restricted ? 'RESTRICTED' : atRisk ? 'AT_RISK' : watch ? 'WATCH' : 'HEALTHY';
  const band = HEALTH_SCORE_BANDS[state];
  return { state, health_score: clamp(Math.round(100 - penalty), band.min, band.max), findings };
}

function localDayRange(now: Date, tz: string): { date: string; from: string; to: string } {
  const date = localDateKey(now, tz);
  const [y, m, d] = date.split('-').map(Number);
  const [ny, nm, nd] = addDaysToKey(date, 1).split('-').map(Number);
  return {
    date,
    from: zonedTimeToUtc(y, m, d, 0, 0, tz).toISOString(),
    to: zonedTimeToUtc(ny, nm, nd, 0, 0, tz).toISOString(),
  };
}

export function getLatestHealth(ctx: AppContext, accountId: string): AccountHealth | null {
  return ctx.db.table('account_health').findOne({ account_id: accountId }, { orderBy: 'date DESC, computed_at DESC' }) ?? null;
}

interface CollectedHealth {
  day: { date: string; from: string; to: string };
  tz: string;
  inputs: HealthInputs;
  perf: AccountPerformance;
}

/** Read-only: gather today's (dealer-local) health inputs from real tables. */
function collectHealthInputs(ctx: AppContext, accountId: string): CollectedHealth {
  const account = requireAccount(ctx, accountId);
  const dealer = getDealer(ctx, account.dealer_id);
  const tz = dealer.settings.timezone;
  const day = localDayRange(ctx.clock.now(), tz);

  const outreachSentToday = Number(
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outreach WHERE account_id = ? AND status IN ('SENT', 'SENT_MANUALLY')
       AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at < ?`,
      accountId,
      day.from,
      day.to,
    )?.n ?? 0,
  );
  const publishToday = Number(
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'PUBLISHED'
       AND published_at IS NOT NULL AND published_at >= ? AND published_at < ?`,
      accountId,
      day.from,
      day.to,
    )?.n ?? 0,
  );
  const perf = getAccountPerformance(ctx, accountId);
  const outreachPolicy = effectiveOutreachPolicy(ctx, accountId);
  const publishPolicy = effectivePublishPolicy(ctx, accountId);

  const inputs: HealthInputs = {
    status: account.status,
    auth_state: account.auth_state,
    outreach_sent_today: outreachSentToday,
    daily_outreach_limit: outreachPolicy.daily_limit,
    publish_today: publishToday,
    daily_publish_limit: publishPolicy.daily_limit,
    negative_feedback_7d: perf.negative_feedback_7d,
    reply_rate_30d: perf.reply_rate_30d,
    outreach_sent_30d: perf.outreach_sent_30d,
  };
  return { day, tz, inputs, perf };
}

/** Compute and upsert today's (dealer-local) health snapshot for one account, recording an audited decision. */
export function computeAccountHealth(ctx: AppContext, accountId: string): AccountHealth {
  const { day, tz, inputs, perf } = collectHealthInputs(ctx, accountId);
  const outreachSentToday = inputs.outreach_sent_today;
  const publishToday = inputs.publish_today;
  const evaluation = evaluateAccountHealth(inputs);
  const issues = evaluation.findings.map((f) => f.label);
  const previous = getLatestHealth(ctx, accountId);
  const computedAt = ctx.clock.iso();

  return ctx.db.tx(() => {
    const table = ctx.db.table('account_health');
    const existing = table.findOne({ account_id: accountId, date: day.date });
    const values = {
      health_score: evaluation.health_score,
      state: evaluation.state,
      outreach_sent_today: outreachSentToday,
      publish_today: publishToday,
      negative_feedback_7d: perf.negative_feedback_7d,
      reply_rate_30d: perf.reply_rate_30d,
      conversion_rate_90d: perf.conversion_rate_90d,
      active_leads: perf.leads_owned_active,
      issues,
      computed_at: computedAt,
    };
    const row = existing
      ? table.update(existing.id, values)
      : table.insert({ id: newId('hlth'), account_id: accountId, date: day.date, ...values });

    ctx.audit.decision({
      agent: 'fleet-controller',
      skill: 'account-health',
      decision_type: 'account_health',
      subject_type: 'account',
      subject_id: accountId,
      inputs: { date: day.date, timezone: tz, ...inputs, conversion_rate_90d: perf.conversion_rate_90d, active_leads: perf.leads_owned_active },
      evidence: evaluation.findings,
      output: { health_id: row.id, state: row.state, health_score: row.health_score, issues },
      confidence: 1,
      engine: 'rules',
    });
    if (!previous || previous.state !== row.state) {
      ctx.audit.event({
        actor: 'agent:fleet-controller',
        action: 'account.health_changed',
        entity_type: 'xhs_account',
        entity_id: accountId,
        details: { from: previous?.state ?? null, to: row.state, health_score: row.health_score, issues },
      });
    }
    return row;
  });
}

export function computeFleetHealth(ctx: AppContext, dealerId: string): AccountHealth[] {
  getDealer(ctx, dealerId);
  return ctx.db
    .table('xhs_accounts')
    .findMany({ dealer_id: dealerId }, { orderBy: 'created_at ASC, nickname ASC' })
    .map((account) => computeAccountHealth(ctx, account.id));
}

/**
 * Operability for guards, evaluated LIVE with the same rules as the daily snapshot (so a missing or stale
 * snapshot can never let a limited / negatively-reported account through, nor keep a re-enabled one blocked):
 * disabled / RESTRICTED → blocking; requires_auth / AT_RISK (auth, ≥3 negative responses in 7 days, daily
 * outreach limit reached) / paused / cooldown → not ok but reviewable; otherwise ok. Read-only (no rows written).
 */
export function isAccountOperable(ctx: AppContext, accountId: string): { ok: boolean; blocking: boolean; reason: string } {
  const account = requireAccount(ctx, accountId);
  if (account.status === 'disabled') return { ok: false, blocking: true, reason: '账号已停用' };
  const { inputs } = collectHealthInputs(ctx, accountId);
  const evaluation = evaluateAccountHealth(inputs);
  const labels = (codes: string[]) =>
    evaluation.findings.filter((f) => codes.includes(f.code)).map((f) => f.label).join('；');
  if (evaluation.state === 'RESTRICTED')
    return { ok: false, blocking: true, reason: `账号健康度受限：${labels(['account_disabled']) || '状态RESTRICTED'}` };
  if (account.auth_state === 'requires_auth') return { ok: false, blocking: false, reason: '账号登录授权已失效，需要重新授权' };
  if (evaluation.state === 'AT_RISK')
    return {
      ok: false,
      blocking: false,
      reason: `账号健康度存在风险：${labels(['negative_feedback_high', 'outreach_limit_reached']) || '状态AT_RISK'}`,
    };
  if (account.status === 'paused') return { ok: false, blocking: false, reason: '账号已暂停运营' };
  if (account.status === 'cooldown') return { ok: false, blocking: false, reason: '账号处于冷却期' };
  return { ok: true, blocking: false, reason: '账号状态正常' };
}

export const skill = defineSkill<{ dealer_id: string }, AccountHealth[]>({
  name: 'account-health',
  category: 'operations',
  agent: 'fleet-controller',
  description: '按门店本地日期计算每个小红书账号的健康快照（发送量、负面反馈、回复率、转化率、授权状态），并给出HEALTHY/WATCH/AT_RISK/RESTRICTED判定。',
  input: v.object({ dealer_id: v.string({ min: 1 }) }),
  run(ctx, input) {
    return computeFleetHealth(ctx, input.dealer_id);
  },
  validateOutput(output) {
    for (const h of output) {
      const band = HEALTH_SCORE_BANDS[h.state];
      if (h.health_score < band.min || h.health_score > band.max)
        throw new Error(`account-health: score ${h.health_score} outside ${h.state} band`);
    }
  },
});
