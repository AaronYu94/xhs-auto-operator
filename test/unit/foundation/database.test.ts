import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import { textSimilarity, meaningfulLength, formatCny } from '../../../src/core/text.ts';
import { localDateKey, localTimeKey, zonedTimeToUtc } from '../../../src/core/time.ts';
import { v } from '../../../src/core/validate.ts';
import { TABLE_META } from '../../../src/db/schema.ts';
import { UnavailableXhsProvider } from '../../../src/providers/xhs/unavailable.ts';
import { XHS_CAPABILITIES } from '../../../src/core/types.ts';
import { createTestContext } from '../../helpers/context.ts';

function seedGroupDealer(ctx: ReturnType<typeof createTestContext>) {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: 'Test Group', created_at: now });
  const dealer = ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: '杭州测试宝马',
    brands: ['BMW'],
    city: '杭州',
    province: '浙江',
    address: '杭州市测试路1号',
    business_hours: '09:00-18:00',
    phone: null,
    settings: {
      outreach_approval_policy: 'REVIEW_REQUIRED',
      publish_approval_policy: 'REVIEW_REQUIRED',
      daily_outreach_limit: 20,
      min_outreach_interval_minutes: 3,
      max_unanswered_touches: 2,
      follow_up_after_days: 2,
      daily_publish_limit: 2,
      max_ai_conversation_turns: 6,
      auto_send_min_score: 90,
      timezone: 'Asia/Shanghai',
    },
    created_at: now,
    updated_at: now,
  });
  return { group, dealer };
}

describe('foundation: database', () => {
  it('migrates every table declared in TABLE_META', () => {
    const ctx = createTestContext();
    for (const name of Object.keys(TABLE_META)) {
      const row = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`, name);
      assert.equal(row?.n, 1, `table ${name} missing`);
    }
    assert.deepEqual(ctx.db.migrate(), [], 'migrations are idempotent');
  });

  it('round-trips JSON and boolean columns and auto-stamps updated_at', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedGroupDealer(ctx);
    assert.deepEqual(dealer.brands, ['BMW']);
    assert.equal(dealer.settings.timezone, 'Asia/Shanghai');

    const now = ctx.clock.iso();
    const lead = ctx.db.table('leads').insert({
      id: newId('lead'),
      group_id: group.id,
      dealer_id: dealer.id,
      platform: 'xiaohongshu',
      platform_user_id: 'u1',
      username: '小明',
      profile_url: null,
    avatar_url: null,
      stage: 'DISCOVERED',
      score: 0,
      tier: 'none',
      intent: { model: 'i3', inventory_intent: true },
      evidence: [{ code: 'inventory_intent', label: '询问现车', quote: '有现车吗' }],
      primary_signal_id: null,
      signal_count: 0,
      first_seen_at: now,
      last_signal_at: now,
      suppressed: false,
      suppression_reason: null,
      contact: {},
      lost_reason: null,
      estimated_value: 0,
      attributed_post_id: null,
      attributed_query_id: null,
      next_action: null,
      created_at: now,
      updated_at: now,
    });
    assert.equal(lead.suppressed, false);
    assert.equal(lead.intent.inventory_intent, true);

    ctx.clock.advance({ minutes: 5 });
    const updated = ctx.db.table('leads').update(lead.id, { suppressed: true, score: 42 });
    assert.equal(updated.suppressed, true);
    assert.equal(updated.score, 42);
    assert.notEqual(updated.updated_at, lead.updated_at);

    assert.equal(ctx.db.table('leads').count({ suppressed: true }), 1);
    assert.equal(ctx.db.table('leads').findMany({ stage: ['DISCOVERED', 'CANDIDATE'] }).length, 1);
    assert.equal(ctx.db.table('leads').query('score >= ?', [40]).length, 1);
  });

  it('enforces lead identity uniqueness per group (dedup at DB level)', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedGroupDealer(ctx);
    const now = ctx.clock.iso();
    const base = {
      group_id: group.id,
      dealer_id: dealer.id,
      platform: 'xiaohongshu' as const,
      platform_user_id: 'dup-user',
      username: 'x',
      profile_url: null,
    avatar_url: null,
      stage: 'DISCOVERED' as const,
      score: 0,
      tier: 'none' as const,
      intent: {},
      evidence: [],
      primary_signal_id: null,
      signal_count: 0,
      first_seen_at: now,
      last_signal_at: now,
      suppressed: false,
      suppression_reason: null,
      contact: {},
      lost_reason: null,
      estimated_value: 0,
      attributed_post_id: null,
      attributed_query_id: null,
      next_action: null,
      created_at: now,
      updated_at: now,
    };
    ctx.db.table('leads').insert({ id: newId('lead'), ...base });
    assert.throws(() => ctx.db.table('leads').insert({ id: newId('lead'), ...base }), /UNIQUE/);
  });

  it('rejects enum values outside the canonical lists', () => {
    const ctx = createTestContext();
    assert.throws(
      () =>
        ctx.db.run(
          `INSERT INTO workflow_runs (id, workflow, trigger, status, started_at) VALUES ('r', 'w', 'manual', 'NOPE', 't')`,
        ),
      /CHECK/,
    );
    assert.throws(
      () =>
        ctx.db.run(
          `INSERT INTO workflow_runs (id, workflow, trigger, status, started_at) VALUES ('r2', 'w', 'cron', 'RUNNING', 't')`,
        ),
      /CHECK/,
    );
  });

  it('rolls back failed transactions and rejects async callbacks', () => {
    const ctx = createTestContext();
    assert.throws(() =>
      ctx.db.tx(() => {
        ctx.db.table('dealer_groups').insert({ id: 'g1', name: 'g', created_at: ctx.clock.iso() });
        throw new Error('boom');
      }),
    );
    assert.equal(ctx.db.table('dealer_groups').count(), 0);
    assert.throws(() => ctx.db.tx(() => Promise.resolve(1)), /async/);
  });

  it('records agent decisions and audit events', () => {
    const ctx = createTestContext();
    const d = ctx.audit.withRun('run_x').decision({
      agent: 'lead-scoring-agent',
      skill: 'lead-scoring',
      decision_type: 'lead_score',
      subject_type: 'lead',
      subject_id: 'lead_1',
      inputs: { a: 1 },
      evidence: [{ code: 'x', label: 'y' }],
      output: { score: 90 },
      confidence: 1.4,
      engine: 'rules',
    });
    assert.equal(d.confidence, 1);
    assert.equal(d.workflow_run_id, 'run_x');
    ctx.audit.event({ actor: 'system', action: 'lead.created', entity_type: 'lead', entity_id: 'lead_1' });
    assert.equal(ctx.audit.decisionsFor('lead', 'lead_1').length, 1);
    assert.equal(ctx.audit.eventsFor('lead', 'lead_1').length, 1);
  });
});

describe('foundation: core utilities', () => {
  it('computes Asia/Shanghai local dates and converts wall time to UTC', () => {
    const d = new Date('2026-09-12T17:30:00Z'); // 01:30 next day in Shanghai
    assert.equal(localDateKey(d, 'Asia/Shanghai'), '2026-09-13');
    assert.equal(localTimeKey(d, 'Asia/Shanghai'), '01:30');
    assert.equal(zonedTimeToUtc(2026, 9, 13, 9, 30, 'Asia/Shanghai').toISOString(), '2026-09-13T01:30:00.000Z');
  });

  it('measures Chinese text similarity and meaningful length', () => {
    assert.equal(meaningfulLength('帅！！😍[赞R]'), 1);
    assert.ok(textSimilarity('杭州i3现在落地多少', '杭州i3现在落地价多少') > 0.6);
    assert.ok(textSimilarity('杭州i3现在落地多少', '宝马X3保养费用') < 0.2);
    assert.equal(formatCny(353900), '35.39万');
  });

  it('validates input shapes with typed errors', () => {
    const schema = v.object({ dealer_id: v.string({ min: 1 }), days: v.optional(v.number({ int: true, min: 1 })) });
    assert.deepEqual(schema({ dealer_id: 'd1' }), { dealer_id: 'd1' });
    assert.throws(() => schema({ dealer_id: '' }), /dealer_id/);
    assert.throws(() => schema({ dealer_id: 'd', days: 1.5 }), /integer/);
  });
});

describe('foundation: unavailable provider', () => {
  it('reports every capability as UNAVAILABLE and never fakes success', async () => {
    const ctx = createTestContext();
    const report = await ctx.xhs.capabilities('acc_1');
    for (const cap of XHS_CAPABILITIES) assert.equal(report.capabilities[cap].status, 'UNAVAILABLE');
    const res = await new UnavailableXhsProvider(ctx.clock).sendMessage('acc', 'user', 'hi');
    assert.equal(res.ok, false);
    assert.equal(ctx.llm.status().status, 'UNAVAILABLE');
  });
});
