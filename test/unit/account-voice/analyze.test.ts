/**
 * Measuring a voice: the numbers, the rules they produce, resistance to one odd post, which notes become few-shot
 * material, and the line between writing in a voice and reprinting a note.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AVOID_SUPPORT,
  COPY_SIMILARITY,
  MIN_SAMPLES,
  RULE_SUPPORT,
  checkCopy,
  deriveRules,
  measure,
  pickExamples,
  usableSamples,
  vocabulary,
  type VoiceSample,
} from '../../../src/skills/content/account-voice/analyze.ts';

const note = (over: Partial<VoiceSample> & { platform_note_id: string; content: string }): VoiceSample => ({
  title: '标题',
  tags: [],
  published_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

/** 销售型账号: short lines, emoji, 你, a call to action every time. */
const SALES: VoiceSample[] = [
  note({
    platform_note_id: 'n1',
    title: '🔥G6提车实拍｜这个配色绝了',
    content: '今天又交付一台G6～\n颜色是星暮紫，太出片了！\n\n最近来看车的朋友挺多的。\n有想看实车的，评论区扣1，我拉你进群。',
    tags: ['小鹏G6', '提车', '舟山'],
  }),
  note({
    platform_note_id: 'n2',
    title: '✨这周到店的新车都在这了',
    content: '本周到店三台～\n都在店里，随时可以看。\n\n想试驾的私信我，帮你安排时间。',
    tags: ['小鹏', '试驾', '舟山'],
  }),
  note({
    platform_note_id: 'n3',
    title: '🚗你以为的智驾 VS 实际的智驾',
    content: '好多朋友问我智驾好不好用～\n我自己每天上下班都在开。\n\n堵车的时候真的省事。\n想体验的评论区找我。',
    tags: ['智驾', '小鹏', '舟山'],
  }),
];

/** 专业型账号: long paragraphs, 您, no emoji, no CTA. */
const EXPERT: VoiceSample[] = [
  note({
    platform_note_id: 'm1',
    title: '关于增程与纯电的选择建议',
    content: '很多用户在增程和纯电之间犹豫。如果您每天的通勤距离不长，家里也具备充电条件，纯电在使用成本上更有优势。如果您经常跑长途，增程在补能上会更从容一些。',
    tags: ['购车指南'],
  }),
  note({
    platform_note_id: 'm2',
    title: '交付前需要确认的几项内容',
    content: '在交付之前，建议您重点确认车辆的生产日期、随车资料是否齐全，以及交付时的电池健康状态。这些信息门店都可以提供，您也可以现场核对。',
    tags: ['交付'],
  }),
  note({
    platform_note_id: 'm3',
    title: '智能辅助驾驶的使用边界',
    content: '辅助驾驶并不是自动驾驶，使用时您仍然需要保持对路面的关注。我们建议您在熟悉的路段先体验，逐步了解系统的能力边界之后再扩大使用范围。',
    tags: ['用车知识'],
  }),
];

describe('语言风格：量化', () => {
  it('measures what the account actually does, not what it claims', () => {
    const m = measure(SALES);
    assert.equal(m.sample_count, 3);
    assert.ok(m.title_emoji_share >= 0.9, '这个账号每条标题都带 emoji');
    assert.ok(m.cta_share >= 0.9, '每篇都有引导');
    assert.ok(m.you_casual_share > m.you_formal_share, '用「你」不用「您」');
    assert.ok(m.tilde_share >= 0.9);
    assert.ok(m.short_sentence_share > 0.5, '短句为主');

    const e = measure(EXPERT);
    assert.equal(e.title_emoji_share, 0);
    assert.equal(e.cta_share, 0);
    assert.ok(e.you_formal_share >= 0.9, '专业号一直用「您」');
    assert.ok(e.sentence_chars_median > measure(SALES).sentence_chars_median, '句子明显更长');
  });

  it('turns measurements into rules a writer can follow, each with its basis', () => {
    const m = measure(SALES);
    const { rules, avoid } = deriveRules(m, vocabulary(SALES));
    const text = rules.map((r) => r.rule).join(' | ');
    assert.match(text, /标题写 \d+–\d+ 个字/);
    assert.match(text, /标题里带 emoji/);
    assert.match(text, /称呼客户用「你」/);
    assert.match(text, /结尾要有引导/);
    assert.ok(rules.every((r) => r.basis.trim().length > 0), '每条规则都要说明依据');
    assert.ok(!/专业|年轻|活泼/.test(text), '规则不是标签');

    const expert = deriveRules(measure(EXPERT), vocabulary(EXPERT));
    const expertText = expert.rules.map((r) => r.rule).join(' | ');
    assert.match(expertText, /称呼客户用「您」/);
    assert.ok(expert.avoid.some((a) => /标题不要加 emoji/.test(a)));
    assert.ok(expert.avoid.some((a) => /结尾不要硬加引导/.test(a)));
    assert.ok(!/标题里带 emoji/.test(expertText));
    void avoid;
  });

  it('one odd post does not become the voice', () => {
    const odd = note({
      platform_note_id: 'x1',
      title: '【转发】厂家公告',
      content: `${'公告内容。'.repeat(80)}`,
      tags: [],
    });
    const before = measure(SALES);
    const after = measure([...SALES, odd]);
    assert.ok(Math.abs(after.body_chars_median - before.body_chars_median) < before.body_chars_median * 0.5, '中位数不会被一篇长文拉走');
    const rules = deriveRules(after, vocabulary([...SALES, odd])).rules.map((r) => r.rule).join(' | ');
    assert.match(rules, /标题里带 emoji/, '3/4 仍然超过支持阈值');
    assert.match(rules, /结尾要有引导/);

    // …and a habit only half the notes show does not become a rule
    const mixed = measure([...SALES.slice(0, 1), ...EXPERT.slice(0, 1)]);
    const mixedRules = deriveRules(mixed, vocabulary([...SALES.slice(0, 1), ...EXPERT.slice(0, 1)])).rules.map((r) => r.rule).join(' | ');
    assert.ok(!/称呼客户用「您」/.test(mixedRules) || !/称呼客户用「你」/.test(mixedRules), '两种都只有一半，不该同时定成规则');
    assert.ok(RULE_SUPPORT > AVOID_SUPPORT);
  });

  it('few-shot examples are the typical notes, not the longest or the loudest', () => {
    const outlier = note({ platform_note_id: 'x2', title: '短', content: '到店看车。', tags: [] });
    const samples = [...SALES, outlier];
    const examples = pickExamples(samples, measure(samples), 2);
    assert.ok(!examples.some((e) => e.platform_note_id === 'x2'), '过短的异常笔记不做范例');
    assert.ok(examples.every((e) => e.excerpt.length > 0 && e.title.length > 0));
    // the excerpt is the account's real text, not a rewrite
    const source = samples.find((s) => s.platform_note_id === examples[0].platform_note_id)!;
    assert.ok(source.content.startsWith(examples[0].excerpt.slice(0, 20)));
  });

  it('skips notes too short to carry style, and says how many are usable', () => {
    const thin = note({ platform_note_id: 'x3', content: '好' });
    assert.equal(usableSamples([...SALES, thin]).length, SALES.length);
    assert.equal(MIN_SAMPLES, 3);
  });
});

describe('学风格 ≠ 抄内容', () => {
  it('new writing in the same voice passes; a reprint does not', () => {
    const fresh = '今天到店两台G7～\n蓝色特别显大。\n\n想看实车的评论区扣1，我安排时间。';
    const clean = checkCopy(fresh, SALES);
    assert.equal(clean.copied, false, `同一种写法但内容是新的（相似度 ${clean.similarity}）`);

    const reprint = checkCopy(SALES[0].content, SALES);
    assert.equal(reprint.copied, true);
    assert.equal(reprint.platform_note_id, 'n1');
    assert.ok(reprint.similarity >= COPY_SIMILARITY || (reprint.shared ?? '').length >= 18);
  });

  it('catches a long verbatim passage even inside otherwise new text', () => {
    const spliced = `这周新到几台车。\n${'有想看实车的，评论区扣1，我拉你进群。'}\n欢迎随时来店里坐坐喝杯咖啡聊聊车。`;
    const check = checkCopy(spliced, SALES);
    assert.equal(check.copied, true, '整句照搬也算抄');
    assert.ok((check.shared ?? '').length >= 18);
  });

  it('an empty or unrelated text is never flagged', () => {
    assert.equal(checkCopy('', SALES).copied, false);
    assert.equal(checkCopy('门店今天正常营业，欢迎到店。', SALES).copied, false);
  });
});
