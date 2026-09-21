/**
 * The 车型库 as the four agents use it: content, outreach, conversation and the lead pipeline all read the same
 * line-up, so a trim that was archived stops being sold everywhere at once, and a card's material only ever shapes
 * wording — never a number.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { gatherInputs } from '../../../src/skills/content/post-generation/composer.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { getDealerProfile, verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import { archiveVehicle, updateVehicle } from '../../../src/skills/operations/vehicle-brain/index.ts';
import { composeOutreachMessage } from '../../../src/skills/sales/outreach/composer.ts';
import { processInboundMessage } from '../../../src/skills/sales/conversation/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedAssignment, seedLead, seedOutreach, vehicleIdByKey } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return {
    ctx,
    summary,
    hz: dealerIdByKey(summary, 'hz-bmw'),
    wang: accountIdByPlatformId(summary, 'xhs-hz-sales-wang'),
    i3: vehicleIdByKey(summary, 'i3-edrive35l'),
    i3big: vehicleIdByKey(summary, 'i3-edrive40l'),
  };
}
type Setup = ReturnType<typeof setup>;

function contactedLead(s: Setup, content: string, user = 'u-veh-1') {
  const detection = detectIntentRules(content, { source_type: 'comment', post_title: '宝马i3现在值得买吗？' }, getDealerProfile(s.ctx, s.hz));
  const created = upsertLeadFromSignal(s.ctx, {
    dealer_id: s.hz,
    identity: { platform_user_id: user, username: user },
    signal: { source_type: 'comment', content, signal_at: s.ctx.clock.iso(), detection },
  });
  const lead = transitionLead(s.ctx, created.lead.id, 'CONTACTED', { reason: 'test', actor: 'operator:test' }).lead;
  const assignment = seedAssignment(s.ctx, { lead_id: lead.id, account_id: s.wang });
  seedOutreach(s.ctx, { lead_id: lead.id, account_id: s.wang, assignment_id: assignment.id, status: 'SENT_MANUALLY' });
  return lead;
}

describe('conversation agent ← 车型库', () => {
  it('answers from the card FAQ when no Dealer Brain fact kind covers the question', async () => {
    const s = setup();
    updateVehicle(
      s.ctx,
      s.i3,
      { faqs: [{ question: '充电方便吗？', answer: '支持快充，门店可以协助申请家用充电桩，安装前会先上门勘察。' }] },
      'operator:li',
    );
    contactedLead(s, '宝马i3 35L现在什么价');
    const r = await processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-veh-1', content: '这车充电方便吗？', source: 'manual' });
    assert.ok(r.reply_draft, '有草稿');
    assert.match(r.reply_draft.content, /支持快充/);
    assert.ok(r.reply_draft.fact_refs.some((f) => f.kind === 'vehicle'));
    assert.equal(verifyClaims(s.ctx, s.hz, r.reply_draft.content, r.reply_draft.fact_refs).passed, true);
  });

  it('a question with no matching FAQ still falls back to asking, never to invented text', async () => {
    const s = setup();
    contactedLead(s, '宝马i3 35L现在什么价');
    const r = await processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-veh-1', content: '你们店附近好停车吗', source: 'manual' });
    if (r.reply_draft) assert.doesNotMatch(r.reply_draft.content, /充电|停车位/);
  });
});

describe('outreach agent ← 车型库', () => {
  it('an archived trim is no longer offered to a lead who asked for it', async () => {
    const s = setup();
    const lead = seedLead(s.ctx, { dealer_id: s.hz, platform_user_id: 'u-veh-2', stage: 'QUALIFIED' });
    s.ctx.db.table('leads').update(lead.id, { intent: { ...lead.intent, brand: 'BMW', model: 'i3', trim: 'eDrive35L' } });
    archiveVehicle(s.ctx, s.i3, 'operator:li');
    const composed = composeOutreachMessage(s.ctx, {
      lead: s.ctx.db.table('leads').require(lead.id),
      account: s.ctx.db.table('xhs_accounts').require(s.wang),
      persona: s.ctx.db.table('account_personas').findOne({ account_id: s.wang })!,
      dealer: s.ctx.db.table('dealers').require(s.hz),
      signal: null,
      kind: 'first_touch',
    });
    // eDrive40L is the live i3 the store can actually sell; the archived 35L must not be quoted.
    assert.doesNotMatch(composed.message, /eDrive35L/);
    assert.equal(verifyClaims(s.ctx, s.hz, composed.message, composed.fact_refs).passed, true);
  });
});

describe('lead pipeline ← 车型库', () => {
  it('an archived trim never sets a lead value, and 当前售价 does when it is set', () => {
    const s = setup();
    updateVehicle(s.ctx, s.i3, { current_price: 333_900 }, 'operator:li');
    const lead = contactedLead(s, '宝马i3 35L现在什么价', 'u-veh-3');
    assert.equal(lead.estimated_value, 333_900, '线索价值用门店真实在售价，不是指导价');

    // Archive that trim: a new lead asking for the same model is worth the live entry trim instead.
    archiveVehicle(s.ctx, s.i3, 'operator:li');
    const after = contactedLead(s, '宝马i3 35L现在什么价', 'u-veh-4');
    assert.equal(after.estimated_value, 403_900, 'eDrive40L 是还在售的 i3');
  });
});

describe('content agent ← 车型库', () => {
  it('takes the angle and the material from the card, and none of its numbers as facts', () => {
    const s = setup();
    updateVehicle(
      s.ctx,
      s.i3,
      {
        description: '城市通勤的纯电轿车',
        highlights: ['充电快'],
        target_customers: ['第一次买电车的家庭'],
        content_angles: ['第一次买电车最担心的三件事'],
      },
      'operator:li',
    );
    const post = s.ctx.db.table('posts').insert({
      id: 'post_veh_1',
      dealer_id: s.hz,
      account_id: s.wang,
      plan_id: null,
      slot_date: '2026-09-12',
      pillar: 'model_review',
      topic: 'i3:model_review',
      angle: '',
      model: 'i3',
      title: '',
      body: '',
      tags: [],
      cover_text: '',
      images: [],
      video: null,
      fact_refs: [],
      status: 'PLANNED',
      review: null,
      approval_policy: 'REVIEW_REQUIRED',
      platform_note_id: null,
      scheduled_for: null,
      published_at: null,
      metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
      metrics_updated_at: null,
      engine: 'rules',
      created_at: s.ctx.clock.iso(),
      updated_at: s.ctx.clock.iso(),
    });
    const inputs = gatherInputs(s.ctx, post);
    assert.equal(inputs.angle, '第一次买电车最担心的三件事', '没有指定角度时用车型库的选题');
    assert.deepEqual(inputs.material.target_customers, ['第一次买电车的家庭']);
    assert.equal(inputs.material.description, '城市通勤的纯电轿车');
  });

  it('an archived trim contributes no material', () => {
    const s = setup();
    updateVehicle(s.ctx, s.i3, { description: '城市通勤的纯电轿车', content_angles: ['不该被用到的角度'] }, 'operator:li');
    archiveVehicle(s.ctx, s.i3, 'operator:li');
    const post = s.ctx.db.table('posts').insert({
      id: 'post_veh_2',
      dealer_id: s.hz,
      account_id: s.wang,
      plan_id: null,
      slot_date: '2026-09-12',
      pillar: 'model_review',
      topic: 'i3:model_review',
      angle: '',
      model: 'i3',
      title: '',
      body: '',
      tags: [],
      cover_text: '',
      images: [],
      video: null,
      fact_refs: [],
      status: 'PLANNED',
      review: null,
      approval_policy: 'REVIEW_REQUIRED',
      platform_note_id: null,
      scheduled_for: null,
      published_at: null,
      metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
      metrics_updated_at: null,
      engine: 'rules',
      created_at: s.ctx.clock.iso(),
      updated_at: s.ctx.clock.iso(),
    });
    const inputs = gatherInputs(s.ctx, post);
    assert.notEqual(inputs.angle, '不该被用到的角度');
  });
});
