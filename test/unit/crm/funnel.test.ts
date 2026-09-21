import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { LEAD_STAGES, type Lead, type LeadStage } from '../../../src/core/types.ts';
import {
  STAGE_INDEX,
  STAGE_WIN_PROBABILITY,
  canTransition,
  getLeadTimeline,
  reopenLead,
  skill as crmSkill,
  stageAtLeast,
  transitionLead,
} from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';

function seedDealer(ctx: TestContext) {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
  const dealer = ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: '杭州宝马中心',
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

let userSeq = 0;
function insertLead(ctx: TestContext, dealer: { id: string; group_id: string }, patch: Partial<Lead> = {}): Lead {
  const now = ctx.clock.iso();
  return ctx.db.table('leads').insert({
    id: newId('lead'),
    group_id: dealer.group_id,
    dealer_id: dealer.id,
    platform: 'xiaohongshu',
    platform_user_id: `u-funnel-${++userSeq}`,
    username: '看车用户',
    profile_url: null,
    avatar_url: null,
    stage: 'CANDIDATE',
    score: 50,
    tier: 'candidate',
    intent: { brand: 'BMW', model: 'i3' },
    evidence: [],
    primary_signal_id: null,
    signal_count: 1,
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
    ...patch,
  });
}

const isPolicy = (code: string) => (err: unknown) => err instanceof PolicyError && err.code === code;
const idx = (s: LeadStage) => LEAD_STAGES.indexOf(s);

/** Independent oracle of ARCHITECTURE §4 used to check every (from, to) pair. */
function expected(from: LeadStage, to: LeadStage): 'change' | 'noop' | 'invalid' {
  if ((from === 'WON' && to === 'LOST') || (from === 'LOST' && to === 'WON')) return 'invalid';
  if (from === 'WON' || from === 'LOST' || from === to) return 'noop';
  if (to === 'LOST') return 'change';
  if (to === 'WON') return idx(from) >= idx('CONTACTED') ? 'change' : 'invalid';
  return idx(to) > idx(from) ? 'change' : 'noop';
}

describe('crm: funnel constants', () => {
  it('indexes stages in LEAD_STAGES order', () => {
    assert.deepEqual(Object.keys(STAGE_INDEX), [...LEAD_STAGES]);
    LEAD_STAGES.forEach((s, i) => assert.equal(STAGE_INDEX[s], i));
  });

  it('assigns calibrated win probabilities', () => {
    assert.deepEqual(STAGE_WIN_PROBABILITY, {
      DISCOVERED: 0, CANDIDATE: 0.01, QUALIFIED: 0.02, ASSIGNED: 0.03, OUTREACH_READY: 0.03, CONTACTED: 0.05,
      REPLIED: 0.1, SALES_QUALIFIED: 0.2, CONTACT_ACQUIRED: 0.3, APPOINTMENT: 0.4, VISITED: 0.55, NEGOTIATING: 0.7,
      WON: 1, LOST: 0,
    });
    const open = LEAD_STAGES.filter((s) => s !== 'LOST');
    for (let i = 1; i < open.length; i++)
      assert.ok(STAGE_WIN_PROBABILITY[open[i]] >= STAGE_WIN_PROBABILITY[open[i - 1]], `${open[i]} not monotonic`);
  });

  it('stageAtLeast treats LOST as outside the forward funnel', () => {
    assert.equal(stageAtLeast('REPLIED', 'CONTACTED'), true);
    assert.equal(stageAtLeast('WON', 'NEGOTIATING'), true);
    assert.equal(stageAtLeast('LOST', 'CONTACTED'), false);
    assert.equal(stageAtLeast('ASSIGNED', 'CONTACTED'), false);
  });
});

describe('crm: exhaustive transition matrix', () => {
  it('matches the funnel rules for every (from, to) pair, writing rows only on real changes', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    let changes = 0;
    for (const from of LEAD_STAGES) {
      for (const to of LEAD_STAGES) {
        const want = expected(from, to);
        const label = `${from} → ${to}`;
        assert.equal(canTransition(from, to), want === 'change', `canTransition ${label}`);

        const lead = insertLead(ctx, dealer, { stage: from, lost_reason: from === 'LOST' ? '预算不够' : null });
        const meta = { reason: `matrix ${label}`, actor: 'agent:crm-agent' };
        if (want === 'invalid') {
          assert.throws(() => transitionLead(ctx, lead.id, to, meta), isPolicy('invalid_transition'), label);
          assert.equal(ctx.db.table('leads').require(lead.id).stage, from, `${label} stage unchanged`);
        } else {
          const res = transitionLead(ctx, lead.id, to, meta);
          assert.equal(res.changed, want === 'change', label);
          assert.equal(res.lead.stage, want === 'change' ? to : from, label);
          if (want === 'change') {
            changes++;
            assert.equal(res.transition?.from_stage, from, label);
            assert.equal(res.transition?.to_stage, to, label);
            assert.equal(res.transition?.reason, meta.reason);
            assert.equal(res.transition?.actor, meta.actor);
            assert.ok(res.lead.next_action, `${label} next action set`);
          } else {
            assert.equal(res.transition, null, label);
          }
        }
        const rows = ctx.db.table('lead_stage_transitions').findMany({ lead_id: lead.id });
        const events = ctx.db.table('audit_events').findMany({ entity_id: lead.id, action: 'lead.stage_changed' });
        assert.equal(rows.length, want === 'change' ? 1 : 0, `${label} transition rows`);
        assert.equal(events.length, want === 'change' ? 1 : 0, `${label} audit events`);
        if (want === 'change') assert.deepEqual(
          { from: events[0].details.from, to: events[0].details.to, reason: events[0].details.reason },
          { from, to, reason: meta.reason },
        );
      }
    }
    // 12 non-terminal stages: LOST from each (12) + WON from CONTACTED..NEGOTIATING (7) + forward pairs (66)
    assert.equal(changes, 12 + 7 + 66);
  });

  it('rejects unknown stages in canTransition without throwing', () => {
    assert.equal(canTransition('CANDIDATE', 'NOPE' as LeadStage), false);
  });
});

describe('crm: transitionLead', () => {
  it('records a forward jump as one transition and is idempotent afterwards', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer, { stage: 'QUALIFIED' });

    const first = transitionLead(ctx, lead.id, 'OUTREACH_READY', { reason: 'outreach prepared', actor: 'agent:outreach-agent' });
    assert.equal(first.changed, true);
    assert.equal(first.lead.stage, 'OUTREACH_READY');
    assert.equal(first.lead.next_action, '生成个性化私信');

    ctx.clock.advance({ minutes: 1 });
    const again = transitionLead(ctx, lead.id, 'OUTREACH_READY', { reason: 'retry', actor: 'agent:outreach-agent' });
    const earlier = transitionLead(ctx, lead.id, 'ASSIGNED', { reason: 'late assignment', actor: 'agent:fleet-controller' });
    assert.equal(again.changed, false);
    assert.equal(earlier.changed, false);
    assert.equal(earlier.lead.stage, 'OUTREACH_READY');
    assert.equal(earlier.lead.updated_at, first.lead.updated_at, 'no-op does not touch the row');
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id }), 1);
  });

  it('rejects WON before the lead was contacted', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer, { stage: 'ASSIGNED' });
    assert.throws(
      () => transitionLead(ctx, lead.id, 'WON', { reason: 'closed deal', actor: 'operator:王磊' }),
      isPolicy('invalid_transition'),
    );
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'ASSIGNED');
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id }), 0);

    transitionLead(ctx, lead.id, 'CONTACTED', { reason: 'sent', actor: 'agent:outreach-agent' });
    const won = transitionLead(ctx, lead.id, 'WON', { reason: 'closed deal', actor: 'operator:王磊' });
    assert.equal(won.lead.stage, 'WON');
    assert.equal(won.lead.next_action, '已成交');
  });

  it('sets the lost reason and keeps LOST terminal for forward requests', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer, { stage: 'REPLIED' });
    const lost = transitionLead(ctx, lead.id, 'LOST', { reason: '已在别家提车', actor: 'operator:李娜' });
    assert.equal(lost.lead.lost_reason, '已在别家提车');
    assert.equal(lost.lead.next_action, '已流失：已在别家提车');

    const forward = transitionLead(ctx, lead.id, 'APPOINTMENT', { reason: 'late reply', actor: 'agent:conversation-agent' });
    assert.equal(forward.changed, false);
    assert.equal(forward.lead.stage, 'LOST');
    assert.throws(() => transitionLead(ctx, lead.id, 'WON', { reason: 'x', actor: 'operator:李娜' }), isPolicy('invalid_transition'));

    const noReason = insertLead(ctx, dealer, { stage: 'CANDIDATE' });
    assert.equal(transitionLead(ctx, noReason.id, 'LOST', { reason: '', actor: 'system' }).lead.lost_reason, '未说明原因');
  });

  it('refuses to move a suppressed contact forward, but still allows LOST and keeps LOST no-ops silent', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    // lead flagged suppressed but still open (e.g. created by another module after the suppression)
    const flagged = insertLead(ctx, dealer, { stage: 'QUALIFIED', suppressed: true, suppression_reason: '别再发了' });
    assert.throws(
      () => transitionLead(ctx, flagged.id, 'ASSIGNED', { reason: 'assign', actor: 'agent:fleet-controller' }),
      isPolicy('contact_suppressed'),
    );
    assert.equal(ctx.db.table('leads').require(flagged.id).stage, 'QUALIFIED');
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: flagged.id }), 0);

    // lead not flagged, but the user is on the global do-not-contact list
    const global = insertLead(ctx, dealer, { stage: 'CANDIDATE' });
    ctx.db.table('contact_suppressions').insert({
      id: newId('sup'),
      platform: 'xiaohongshu',
      platform_user_id: global.platform_user_id,
      reason: '不需要',
      source: 'conversation:other-group',
      created_at: ctx.clock.iso(),
    });
    assert.throws(
      () => transitionLead(ctx, global.id, 'QUALIFIED', { reason: 'score', actor: 'agent:lead-scoring-agent' }),
      isPolicy('contact_suppressed'),
    );
    const lost = transitionLead(ctx, global.id, 'LOST', { reason: 'do_not_contact: 不需要', actor: 'agent:crm-agent' });
    assert.equal(lost.changed, true);
    assert.equal(lost.lead.stage, 'LOST');
    // a LOST suppressed lead receiving a late forward request is a silent no-op, not an error
    assert.equal(transitionLead(ctx, global.id, 'REPLIED', { reason: 'late reply', actor: 'agent:conversation-agent' }).changed, false);
  });

  it('rolls back the stage change when the audit write fails', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer, { stage: 'QUALIFIED' });
    const original = ctx.audit.event.bind(ctx.audit);
    ctx.audit.event = (e) => {
      if (e.action === 'lead.stage_changed') throw new Error('audit store unavailable');
      return original(e);
    };
    assert.throws(() => transitionLead(ctx, lead.id, 'ASSIGNED', { reason: 'assign', actor: 'agent:fleet-controller' }), /audit store/);
    const after = ctx.db.table('leads').require(lead.id);
    assert.equal(after.stage, 'QUALIFIED');
    assert.equal(after.next_action, null);
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id }), 0);
  });

  it('validates stage, actor and lead id', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer);
    assert.throws(() => transitionLead(ctx, lead.id, 'NOPE' as LeadStage, { reason: '', actor: 'system' }), ValidationError);
    assert.throws(() => transitionLead(ctx, lead.id, 'QUALIFIED', { reason: '', actor: ' ' }), ValidationError);
    assert.throws(() => transitionLead(ctx, 'lead_missing', 'QUALIFIED', { reason: '', actor: 'system' }), NotFoundError);
  });
});

describe('crm: reopenLead', () => {
  it('only lets an operator reopen a LOST lead and clears the lost reason', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, dealer, { stage: 'CONTACTED' });
    transitionLead(ctx, lead.id, 'LOST', { reason: '暂不考虑', actor: 'agent:conversation-agent' });

    assert.throws(
      () => reopenLead(ctx, lead.id, 'QUALIFIED', { reason: 'new signal', actor: 'agent:crm-agent' }),
      isPolicy('operator_required'),
    );
    assert.throws(() => reopenLead(ctx, lead.id, 'QUALIFIED', { reason: '', actor: 'operator:' }), isPolicy('operator_required'));
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'LOST');

    ctx.clock.advance({ hours: 1 });
    const reopened = reopenLead(ctx, lead.id, 'QUALIFIED', { reason: '客户重新询价', actor: 'operator:王磊' });
    assert.equal(reopened.stage, 'QUALIFIED');
    assert.equal(reopened.lost_reason, null);
    assert.equal(reopened.next_action, '分配最合适的账号');

    const { transitions, events } = getLeadTimeline(ctx, lead.id);
    assert.deepEqual(
      transitions.map((t) => [t.from_stage, t.to_stage]),
      [
        ['CONTACTED', 'LOST'],
        ['LOST', 'QUALIFIED'],
      ],
    );
    const reopenEvent = events.filter((e) => e.action === 'lead.stage_changed').at(-1);
    assert.equal(reopenEvent?.actor, 'operator:王磊');
    assert.equal(reopenEvent?.details.reopened, true);
    assert.equal(reopenEvent?.details.previous_lost_reason, '暂不考虑');

    // the reopened lead moves through the funnel again
    assert.equal(transitionLead(ctx, lead.id, 'ASSIGNED', { reason: 'reassigned', actor: 'agent:fleet-controller' }).changed, true);
  });

  it('refuses non-LOST leads, invalid targets and suppressed contacts', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const active = insertLead(ctx, dealer, { stage: 'REPLIED' });
    assert.throws(() => reopenLead(ctx, active.id, 'CANDIDATE', { reason: '', actor: 'operator:王磊' }), isPolicy('invalid_transition'));
    assert.throws(
      () => reopenLead(ctx, active.id, 'ASSIGNED' as 'CANDIDATE', { reason: '', actor: 'operator:王磊' }),
      ValidationError,
    );

    const flagged = insertLead(ctx, dealer, { stage: 'LOST', suppressed: true, suppression_reason: '不需要', lost_reason: 'do_not_contact: 不需要' });
    assert.throws(() => reopenLead(ctx, flagged.id, 'CANDIDATE', { reason: '', actor: 'operator:王磊' }), isPolicy('contact_suppressed'));

    const globallySuppressed = insertLead(ctx, dealer, { stage: 'LOST', lost_reason: '暂不考虑' });
    ctx.db.table('contact_suppressions').insert({
      id: newId('sup'),
      platform: 'xiaohongshu',
      platform_user_id: globallySuppressed.platform_user_id,
      reason: '别再发了',
      source: 'operator:李娜',
      created_at: ctx.clock.iso(),
    });
    assert.throws(
      () => reopenLead(ctx, globallySuppressed.id, 'CANDIDATE', { reason: '', actor: 'operator:王磊' }),
      isPolicy('contact_suppressed'),
    );
    assert.equal(ctx.db.table('leads').require(globallySuppressed.id).stage, 'LOST');
  });
});

describe('crm: skill (transition / reopen)', () => {
  it('validates per action and runs through the registry', async () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    ctx.skills.register(crmSkill);
    assert.equal(crmSkill.agent, 'crm-agent');
    assert.equal(crmSkill.category, 'operations');
    const lead = insertLead(ctx, dealer, { stage: 'CANDIDATE' });

    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'delete', lead_id: lead.id }), ValidationError);
    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'transition', lead_id: lead.id, to: 'SOLD' }), ValidationError);

    const out = await ctx.skills.invoke<{ action: string; changed: boolean; lead: Lead }>(ctx, 'crm', {
      action: 'transition',
      lead_id: lead.id,
      to: 'QUALIFIED',
    });
    assert.equal(out.action, 'transition');
    assert.equal(out.changed, true);
    assert.equal(ctx.db.table('lead_stage_transitions').findOne({ lead_id: lead.id })?.actor, 'agent:crm-agent');

    await ctx.skills.invoke(ctx, 'crm', { action: 'transition', lead_id: lead.id, to: 'LOST', reason: '无效线索' });
    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'reopen', lead_id: lead.id, to: 'CANDIDATE' }), ValidationError);
    const reopened = await ctx.skills.invoke<{ lead: Lead }>(ctx, 'crm', {
      action: 'reopen',
      lead_id: lead.id,
      to: 'CANDIDATE',
      actor: 'operator:王磊',
    });
    assert.equal(reopened.lead.stage, 'CANDIDATE');
  });
});
