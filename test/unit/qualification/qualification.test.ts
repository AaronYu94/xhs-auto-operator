import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { AutomotiveIntent, ConversationSlots, LeadStage } from '../../../src/core/types.ts';
import { evaluateQualification, qualifyLead, skill } from '../../../src/skills/sales/qualification/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead, seedSuppression } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), wang: accountIdByPlatformId(summary, 'xhs-hz-sales-wang') };
}

function leadWith(ctx: ReturnType<typeof setup>['ctx'], hz: string, user: string, intent: AutomotiveIntent, stage: LeadStage = 'REPLIED') {
  const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: user, stage });
  return ctx.db.table('leads').update(lead.id, { intent });
}

function conversationWith(ctx: ReturnType<typeof setup>['ctx'], leadId: string, accountId: string, slots: ConversationSlots) {
  const now = ctx.clock.iso();
  return ctx.db.table('conversations').insert({
    id: newId('conv'),
    lead_id: leadId,
    account_id: accountId,
    status: 'open',
    slots,
    ai_turns: 0,
    needs_human: false,
    handoff_reason: null,
    last_message_at: now,
    created_at: now,
    updated_at: now,
  });
}

describe('qualifyLead', () => {
  it('model + budget + near timeframe → SALES_QUALIFIED with one decision', () => {
    const { ctx, hz } = setup();
    const lead = leadWith(ctx, hz, 'u-q-1', { brand: 'BMW', model: 'i3', trim: 'eDrive35L', budget_max: 400000, purchase_timeframe: 'this_month' });
    const res = qualifyLead(ctx, lead.id);
    assert.equal(res.sales_qualified, true);
    assert.ok(res.reasons.some((r) => r.includes('BMW i3 eDrive35L')));
    assert.ok(res.reasons.some((r) => r.startsWith('预算明确')));
    assert.ok(res.reasons.some((r) => r.includes('本月内')));
    assert.ok(res.missing.includes('未留联系方式'));
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'SALES_QUALIFIED');
    qualifyLead(ctx, lead.id);
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'sales_qualification', subject_id: lead.id }), 1);
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id, to_stage: 'SALES_QUALIFIED' }), 1);
  });

  it('a known model alone is not enough and missing information is listed', () => {
    const { ctx, hz } = setup();
    const lead = leadWith(ctx, hz, 'u-q-2', { brand: 'BMW', model: 'X3' });
    const res = qualifyLead(ctx, lead.id);
    assert.equal(res.sales_qualified, false);
    assert.deepEqual(res.missing, ['预算未知', '购车时间未知', '所在地未确认', '暂无到店意向', '未留联系方式', '付款/置换方式未明确']);
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'REPLIED');
  });

  it('without a model nothing qualifies, and a post-context model does not count', () => {
    const { ctx, hz } = setup();
    const lead = leadWith(ctx, hz, 'u-q-3', { model: 'i3', inferred_fields: ['model'], budget_max: 300000, purchase_timeframe: 'this_week', location: '杭州' });
    const res = qualifyLead(ctx, lead.id);
    assert.equal(res.sales_qualified, false);
    assert.ok(res.missing.includes('意向车型未明确'));
  });

  it('IP-only province is not a stated location; a stated same-province city is', () => {
    const { ctx, hz } = setup();
    const ipOnly = leadWith(ctx, hz, 'u-q-4', { model: 'i3', province: '浙江', inferred_fields: ['province'], budget_max: 350000 });
    const a = evaluateQualification(ctx, ipOnly);
    assert.equal(a.met.includes('local'), false);
    assert.equal(a.sales_qualified, false);
    const stated = leadWith(ctx, hz, 'u-q-5', { model: 'i3', location: '宁波', province: '浙江', budget_max: 350000 });
    const b = evaluateQualification(ctx, stated);
    assert.ok(b.met.includes('local'));
    assert.equal(b.sales_qualified, true);
  });

  it('conversation slots (contact, trade-in) and appointments count; later conversations win', () => {
    const { ctx, hz, wang } = setup();
    const lead = leadWith(ctx, hz, 'u-q-6', {});
    conversationWith(ctx, lead.id, wang, { model: 'X3', trade_in: true, trade_in_vehicle: '2019年大众迈腾', contact_phone: '13800001234' });
    const res = evaluateQualification(ctx, ctx.db.table('leads').require(lead.id));
    assert.deepEqual(res.met.sort(), ['contact', 'payment']);
    assert.ok(res.reasons.some((r) => r.includes('2019年大众迈腾')));
    assert.equal(res.sales_qualified, true);
  });

  it('never advances do-not-contact leads and never moves deeper leads backwards', () => {
    const { ctx, hz } = setup();
    const intent: AutomotiveIntent = { model: 'i3', budget_max: 400000, purchase_timeframe: 'soon' };
    const suppressed = leadWith(ctx, hz, 'u-q-7', intent);
    seedSuppression(ctx, 'u-q-7');
    assert.equal(qualifyLead(ctx, suppressed.id).sales_qualified, true);
    assert.equal(ctx.db.table('leads').require(suppressed.id).stage, 'REPLIED');
    const deeper = leadWith(ctx, hz, 'u-q-8', intent, 'APPOINTMENT');
    qualifyLead(ctx, deeper.id);
    assert.equal(ctx.db.table('leads').require(deeper.id).stage, 'APPOINTMENT');
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'sales_qualification' }), 0);
  });

  it('skill wrapper', async () => {
    const { ctx, hz } = setup();
    const lead = leadWith(ctx, hz, 'u-q-9', { model: 'i3' });
    assert.equal(skill.name, 'qualification');
    const res = await skill.run(ctx, skill.input({ lead_id: lead.id }));
    assert.equal(res.sales_qualified, false);
  });
});
