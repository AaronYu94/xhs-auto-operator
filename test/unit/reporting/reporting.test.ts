import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import { getDashboard } from '../../../src/skills/operations/analytics/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { generateOperatorReport, getLatestReport, latestCapabilityBlocks } from '../../../src/skills/operations/reporting/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function allFinite(value: unknown, path = 'report'): void {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is not finite`);
  else if (Array.isArray(value)) value.forEach((x, i) => allFinite(x, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, x] of Object.entries(value)) allFinite(x, `${path}.${k}`);
}

function setup(): { ctx: TestContext; dealerId: string } {
  const ctx = createTestContext();
  return { ctx, dealerId: dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw') };
}

describe('generateOperatorReport', () => {
  it('numbers equal the analytics dashboard for the same day; provenance and simulation warning', () => {
    const { ctx, dealerId } = setup();
    const live = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-live-1', stage: 'DISCOVERED' });
    const sim = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-sim-1', stage: 'DISCOVERED' });
    ctx.db.table('leads').update(live.id, { data_mode: 'live' });
    ctx.db.table('leads').update(sim.id, { data_mode: 'simulation' });
    for (const lead of [live, sim]) transitionLead(ctx, lead.id, 'QUALIFIED', { reason: 'test', actor: 'test' });

    const row = generateOperatorReport(ctx, dealerId);
    const report = row.report as Record<string, any>;
    const dashboard = getDashboard(ctx, { dealer_id: dealerId, from: row.date, to: row.date });
    assert.equal(row.date, '2026-09-12');
    assert.equal(report.dashboard.discovery.qualified, dashboard.discovery.qualified);
    assert.equal(report.dashboard.discovery.qualified, 2);
    assert.equal(report.provenance.period.live, 1);
    assert.equal(report.provenance.period.simulation, 1);
    const summary = report.summary as string[];
    assert.ok(summary.some((l) => l.includes('合格线索 2 条')), summary.join('\n'));
    assert.ok(summary.some((l) => l.includes('真实小红书 1') && l.includes('模拟数据 1')), summary.join('\n'));
    assert.ok(summary.some((l) => l.includes('1 条模拟数据线索，不是真实客户')));
    allFinite(report);

    assert.equal(getLatestReport(ctx, dealerId)?.id, row.id);
    assert.ok(ctx.db.table('agent_decisions').findOne({ decision_type: 'report', subject_id: dealerId }));
  });

  it('capability blocks come from the latest snapshot per capability; AVAILABLE is omitted', () => {
    const { ctx, dealerId } = setup();
    const insert = (capability: string, status: 'AVAILABLE' | 'UNAVAILABLE' | 'REQUIRES_AUTH', at: string, accountId: string | null = null) =>
      ctx.db.table('capability_snapshots').insert({
        id: newId('cap'),
        provider: ctx.xhs.name,
        account_id: accountId,
        capability: capability as 'search_public_content',
        status,
        reason: `${capability} ${status}`,
        checked_at: at,
      });
    insert('search_public_content', 'REQUIRES_AUTH', '2026-09-11T00:00:00.000Z');
    insert('search_public_content', 'AVAILABLE', '2026-09-12T01:00:00.000Z');
    const account = ctx.db.table('xhs_accounts').findOne({ dealer_id: dealerId })!;
    insert('send_messages', 'UNAVAILABLE', '2026-09-12T01:00:00.000Z', account.id);
    const blocks = latestCapabilityBlocks(ctx, dealerId);
    assert.ok(!blocks.blocks.some((b) => b.capability === 'search_public_content'), 'stale REQUIRES_AUTH replaced by newer AVAILABLE');
    assert.ok(blocks.blocks.some((b) => b.capability === 'send_messages' && b.account_id === account.id));
    assert.ok(blocks.blocks.some((b) => b.capability === 'llm'), 'LLM unavailability is reported');
    const report = generateOperatorReport(ctx, dealerId).report as { summary: string[] };
    assert.ok(report.summary.some((l) => l.includes('能力受限：发送私信')), report.summary.join('\n'));
  });

  it('an empty dealer yields an honest zero report', () => {
    const { ctx, dealerId } = setup();
    const row = generateOperatorReport(ctx, dealerId, '2026-09-10');
    const report = row.report as { summary: string[]; dashboard: { discovery: { posts_scanned: number } } };
    assert.equal(row.date, '2026-09-10');
    assert.equal(report.dashboard.discovery.posts_scanned, 0);
    assert.ok(report.summary.includes('今日没有完成任何公开内容扫描'));
    allFinite(report);
  });
});
