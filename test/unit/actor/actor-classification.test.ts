import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Evidence, IntentDetection } from '../../../src/core/types.ts';
import { ACTOR_LABELS, aggregateActorType, classifyActor } from '../../../src/domain/actor-classification.ts';
import { detectIntentRules, prefilter } from '../../../src/skills/acquisition/intent-detection/nlu.ts';

function detection(partial: Partial<IntentDetection> & { evidence?: Evidence[] }): IntentDetection {
  return {
    is_purchase_signal: false,
    intent: {},
    evidence: [],
    transaction_questions: [],
    strength: 0,
    negative: false,
    engine: 'rules',
    ...partial,
  };
}

describe('classifyActor', () => {
  it('marketing wins over every other signal, even purchase vocabulary', () => {
    const d = detection({
      is_purchase_signal: true,
      is_marketing: true,
      evidence: [{ code: 'marketing_account', label: '营销', quote: '私信我底价' }],
    });
    const c = classifyActor(d);
    assert.equal(c.actor_type, 'DEALER_OR_SALES');
    assert.match(c.reason, /私信我底价/);
  });

  it('industry_account evidence from lead research is DEALER_OR_SALES', () => {
    const c = classifyActor(detection({ evidence: [{ code: 'industry_account', label: '疑似车商/销售账号', quote: '4S店销售顾问' }] }));
    assert.equal(c.actor_type, 'DEALER_OR_SALES');
    assert.equal(c.evidence_code, 'industry_account');
  });

  it('owners and creators are never buyers', () => {
    assert.equal(classifyActor(detection({ author_role: 'owner' })).actor_type, 'OWNER');
    assert.equal(
      classifyActor(detection({ evidence: [{ code: 'already_purchased', label: '已购车', quote: '提车三个月了' }] })).actor_type,
      'OWNER',
    );
    assert.equal(classifyActor(detection({ author_role: 'creator' })).actor_type, 'CREATOR');
    assert.equal(
      classifyActor(detection({ evidence: [{ code: 'content_creator', label: '创作者', quote: '一次说清' }] })).actor_type,
      'CREATOR',
    );
  });

  it('an owner shopping for another car (purchase signal, asker role) is a BUYER', () => {
    const d = detection({
      is_purchase_signal: true,
      author_role: 'asker',
      evidence: [
        { code: 'discount', label: '询问优惠', quote: '优惠多少' },
        { code: 'already_purchased', label: '已购车', quote: '我是车主' },
      ],
    });
    assert.equal(classifyActor(d).actor_type, 'BUYER');
  });

  it('automotive talk without buying stage is ENTHUSIAST; rejected noise is UNKNOWN', () => {
    const enthusiast = detection({ evidence: [{ code: 'stated_brand', label: '提及品牌 宝马', quote: '宝马' }] });
    assert.equal(classifyActor(enthusiast, { passed: true, reason: 'keyword_hit', hits: ['宝马'], is_marketing: false }).actor_type, 'ENTHUSIAST');
    const praise = detection({ evidence: [{ code: 'pure_praise', label: '纯夸赞', quote: '帅' }] });
    assert.equal(classifyActor(praise).actor_type, 'UNKNOWN');
    const refusal = detection({ negative: true, evidence: [{ code: 'not_interested', label: '明确拒绝', quote: '别再发了' }] });
    assert.equal(classifyActor(refusal).actor_type, 'UNKNOWN');
  });

  it('works on real rules-engine output for stable reference texts', () => {
    const ctx = { source_type: 'comment' as const, post_title: '宝马i3现在值得买吗？' };
    const buyer = '杭州i3 35L白外红内有现车吗？这周想去看看';
    assert.equal(classifyActor(detectIntentRules(buyer, ctx), prefilter(buyer, ctx)).actor_type, 'BUYER');
    assert.equal(classifyActor(detectIntentRules('帅', ctx), prefilter('帅', ctx)).actor_type, 'UNKNOWN');
    const spam = '有需要的朋友私信我底价，4S店销售';
    assert.equal(classifyActor(detectIntentRules(spam, ctx), prefilter(spam, ctx)).actor_type, 'DEALER_OR_SALES');
  });

  it('every actor type has a Chinese label', () => {
    for (const label of Object.values(ACTOR_LABELS)) assert.ok(label.length > 0);
  });
});

describe('aggregateActorType', () => {
  it('BUYER once any buyer signal exists; industry overrides; else the latest classified signal', () => {
    assert.equal(aggregateActorType(['ENTHUSIAST', 'BUYER', 'OWNER']), 'BUYER');
    assert.equal(aggregateActorType(['BUYER'], { industry_account: true }), 'DEALER_OR_SALES');
    assert.equal(aggregateActorType(['ENTHUSIAST', null, 'OWNER', undefined]), 'OWNER');
    assert.equal(aggregateActorType([]), 'UNKNOWN');
  });
});
