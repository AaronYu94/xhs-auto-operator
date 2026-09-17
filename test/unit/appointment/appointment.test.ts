import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import {
  cancelAppointment,
  confirmAppointment,
  getActiveAppointment,
  listAppointments,
  markNoShow,
  markVisited,
  skill,
  upsertAppointment,
} from '../../../src/skills/sales/appointment/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead, seedSuppression } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const wang = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
  const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-1', stage: 'REPLIED' });
  ctx.db.table('leads').update(lead.id, { intent: { brand: 'BMW', model: 'i3', trim: 'eDrive35L' } });
  return { ctx, hz, wang, lead };
}

const policyCode = (code: string) => (err: unknown) => err instanceof PolicyError && err.code === code;

describe('upsertAppointment', () => {
  it('creates a proposed appointment at the lead dealer and moves the lead to APPOINTMENT', () => {
    const { ctx, wang, lead } = setup();
    const appt = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '这周六下午', scheduled_for: '2026-09-12T06:00:00Z' });
    assert.equal(appt.status, 'proposed');
    assert.equal(appt.store, '杭州宝马中心');
    assert.equal(appt.scheduled_for, '2026-09-12T06:00:00.000Z');
    assert.equal(appt.time_text, '这周六下午');
    assert.equal(appt.vehicle_interest, 'BMW i3 eDrive35L');
    const fresh = ctx.db.table('leads').require(lead.id);
    assert.equal(fresh.stage, 'APPOINTMENT');
    assert.match(fresh.next_action ?? '', /确认到店/);
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'appointment', subject_id: appt.id }), 1);
    assert.equal(ctx.db.table('audit_events').count({ action: 'appointment.proposed', entity_id: appt.id }), 1);
  });

  it('updates the active appointment instead of creating a second one; a new time re-proposes a confirmed visit', () => {
    const { ctx, wang, lead } = setup();
    const first = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '周六' });
    confirmAppointment(ctx, first.id, 'operator:wang');
    const second = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '下周日上午', scheduled_for: '2026-09-20T02:00:00Z' });
    assert.equal(second.id, first.id);
    assert.equal(second.status, 'proposed');
    assert.equal(second.time_text, '下周日上午');
    assert.equal(ctx.db.table('appointments').count({ lead_id: lead.id }), 1);
    // repeating the same data is a no-op without a new decision
    const decisions = ctx.db.table('agent_decisions').count({ decision_type: 'appointment' });
    upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '下周日上午', scheduled_for: '2026-09-20T02:00:00Z' });
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'appointment' }), decisions);
  });

  it('refuses do-not-contact and closed leads and validates timestamps', () => {
    const { ctx, hz, wang, lead } = setup();
    seedSuppression(ctx, 'u-appt-1');
    assert.throws(() => upsertAppointment(ctx, { lead_id: lead.id, account_id: wang }), policyCode('contact_suppressed'));
    const lost = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-lost', stage: 'LOST' });
    assert.throws(() => upsertAppointment(ctx, { lead_id: lost.id, account_id: wang }), policyCode('lead_closed'));
    const ok = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-2', stage: 'REPLIED' });
    assert.throws(() => upsertAppointment(ctx, { lead_id: ok.id, account_id: wang, scheduled_for: 'not a date' }), /invalid timestamp/);
    assert.equal(ctx.db.table('appointments').count({}), 0);
  });
});

describe('appointment outcomes', () => {
  it('confirm → visited moves the lead to VISITED; outcomes are final', () => {
    const { ctx, wang, lead } = setup();
    const appt = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '明天上午' });
    const confirmed = confirmAppointment(ctx, appt.id, 'operator:wang', '2026-09-13T02:00:00Z');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.scheduled_for, '2026-09-13T02:00:00.000Z');
    const visited = markVisited(ctx, appt.id, 'operator:wang');
    assert.equal(visited.status, 'visited');
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'VISITED');
    assert.throws(() => markNoShow(ctx, appt.id, 'operator:wang'), policyCode('invalid_appointment_status'));
    assert.equal(getActiveAppointment(ctx, lead.id), undefined);
    assert.equal(ctx.db.table('audit_events').count({ action: 'appointment.visited', entity_id: appt.id }), 1);
  });

  it('no-show sets the re-invite next action; cancel keeps the reason', () => {
    const { ctx, hz, wang, lead } = setup();
    const appt = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, time_text: '周六' });
    assert.equal(markNoShow(ctx, appt.id, 'operator:wang').status, 'no_show');
    assert.equal(ctx.db.table('leads').require(lead.id).next_action, '客户未到店：重新邀约');

    const other = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-3', stage: 'REPLIED' });
    const appt2 = upsertAppointment(ctx, { lead_id: other.id, account_id: wang });
    const cancelled = cancelAppointment(ctx, appt2.id, 'operator:wang', '客户临时出差');
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.notes, /客户临时出差/);
  });

  it('lists a dealer calendar soonest first with unscheduled appointments last', () => {
    const { ctx, hz, wang, lead } = setup();
    const b = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-4', stage: 'REPLIED' });
    const c = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-appt-5', stage: 'REPLIED' });
    const late = upsertAppointment(ctx, { lead_id: lead.id, account_id: wang, scheduled_for: '2026-09-15T02:00:00Z' });
    const none = upsertAppointment(ctx, { lead_id: b.id, account_id: wang });
    const soon = upsertAppointment(ctx, { lead_id: c.id, account_id: wang, scheduled_for: '2026-09-13T02:00:00Z' });
    assert.deepEqual(listAppointments(ctx, { dealer_id: hz }).map((a) => a.id), [soon.id, late.id, none.id]);
    assert.deepEqual(listAppointments(ctx, { dealer_id: hz, from: '2026-09-14T00:00:00Z' }).map((a) => a.id), [late.id, none.id]);
  });

  it('skill wrapper dispatches actions', async () => {
    const { ctx, wang, lead } = setup();
    assert.equal(skill.name, 'appointment');
    const appt = await skill.run(ctx, { action: 'upsert', lead_id: lead.id, account_id: wang, time_text: '周日' });
    const confirmed = await skill.run(ctx, { action: 'confirm', appointment_id: appt.id, actor: 'operator:li' });
    assert.equal(confirmed.status, 'confirmed');
    assert.throws(() => skill.input({ action: 'bogus' }), /expected one of|action/);
  });
});
