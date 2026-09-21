/**
 * Steer 动态 shows what a decision means, never a raw record. Every summary is read from the decision's own stored
 * output; when a record carries nothing readable the line is empty (the title alone is shown) instead of an id.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentDecision } from '../../../src/core/types.ts';
import { decisionText, decisionTitle } from '../../../src/server/pages/decision-view.ts';

const d = (decision_type: string, output: Record<string, unknown>, evidence: AgentDecision['evidence'] = []) =>
  ({ decision_type, output, evidence }) as Pick<AgentDecision, 'decision_type' | 'output' | 'evidence'>;

const guards = (n: number, failed?: { detail: string }) => [
  ...Array.from({ length: n - (failed ? 1 : 0) }, (_, i) => ({ check: `c${i}`, passed: true, blocking: false, detail: 'ok' })),
  ...(failed ? [{ check: 'factual_verification', passed: false, blocking: true, detail: failed.detail }] : []),
];

describe('decision view: one Chinese line per decision', () => {
  it('pre-send checks read as a result, not as an outreach id', () => {
    assert.equal(decisionTitle('outreach_guard'), '发私信前的检查');
    assert.equal(decisionText(d('outreach_guard', { status: 'READY_FOR_REVIEW', guards: guards(10) })), '发送前查了 10 项，都没问题，草稿等你看一眼，再由人发出去');
    assert.equal(
      decisionText(d('outreach_guard', { status: 'BLOCKED', guards: guards(10, { detail: '「16.9万落地」涉及落地价：不能在内容中承诺' }) })),
      '被拦下了：「16.9万落地」涉及落地价：不能在内容中承诺',
    );
    // 需人工审核 / 私信能力不可用 fail without blocking: the normal path, never reported as blocked
    const normal = [...guards(8), { check: 'approval_policy', passed: false, blocking: false, detail: '策略要求人工审核后发送' }, { check: 'provider_capability', passed: false, blocking: false, detail: '私信发送能力为 UNAVAILABLE' }];
    assert.equal(decisionText(d('outreach_guard', { status: 'READY_FOR_REVIEW', guards: normal })), '发送前查了 10 项，都没问题，草稿等你看一眼，再由人发出去');
  });

  it('scores, qualification, merges and screening summarise their own numbers', () => {
    assert.equal(decisionText(d('lead_score', { score: 77, tier: 'qualified', previous_score: 76 })), '评分 77（合格），较上次 +1');
    assert.equal(decisionText(d('lead_score', { score: 40, tier: 'candidate', previous_score: 40, out_of_area_capped: true })), '评分 40（候选）；不在本地，分数压低了');
    assert.equal(
      decisionText(d('lead_qualification', { score: 63, components: [{ factor: 'x', points: 0, reason: '无' }, { factor: 'y', points: 25, reason: '购买意向强度 1（选择门店）' }] })),
      '达到合格（63 分）：购买意向强度 1（选择门店）',
    );
    assert.equal(decisionText(d('lead_dedup_merge', { matched_by: 'platform_user_id', intent_merged: true, signal_score: 64 })), '认出是同一个小红书用户，和之前的记到一起（64 分）');
    assert.equal(
      decisionText(d('lead_prefilter', { screen: { by: 'llm', candidates: 14, buyers: 2, rejected: { owner: 5, chatter: 3 }, out_of_area: 1 } })),
      'AI 看了 14 条留言，2 位像是要买车的，排掉同行、车主和闲聊 8 条，1 位不在我们卖车的地方',
    );
  });

  it('falls back to the decision text, then evidence, and never prints ids', () => {
    assert.equal(decisionText(d('lead_research', { reason: 'IP属地 浙江 与门店所在省份一致' })), 'IP属地 浙江 与门店所在省份一致');
    assert.equal(decisionText(d('account_assignment', { assigned: true, reason: '选择「小贺不开快车」（67.8分）' })), '选择「小贺不开快车」（67.8分）');
    assert.equal(decisionText(d('intent_detection', {}, [{ code: 'stated_brand', label: '提及品牌 小鹏', quote: '小鹏' }])), '提及品牌 小鹏：“小鹏”');
    assert.equal(decisionText(d('outreach_guard', {})), '', 'nothing readable → no description, never an id');
    assert.equal(decisionTitle('brand_new_type'), 'AI 判断', '未知类型不会把内部名字印出来');
  });
});
