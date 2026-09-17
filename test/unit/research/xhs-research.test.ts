import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { withRun } from '../../../src/app/context.ts';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { PublicPost, ResearchBrief } from '../../../src/core/types.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimComment } from '../../../src/providers/xhs/simulation.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { runXhsResearch, skill, topicsOfTitle } from '../../../src/skills/research/xhs-research/index.ts';
import { MAX_PROVIDER_QUERIES, isQuestionForm } from '../../../src/skills/research/shared.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

interface CorpusIndex {
  sources: Map<string, string[]>;
  authors: Map<string, string>;
  comments: string[];
}

function corpusIndex(): CorpusIndex {
  const corpus = JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')) as {
    notes: { platform_post_id: string; title: string; content: string; comments: SimComment[] }[];
  };
  const sources = new Map<string, string[]>();
  const authors = new Map<string, string>();
  const comments: string[] = [];
  const walk = (list: SimComment[]) => {
    for (const c of list) {
      sources.set(`comment:${c.platform_comment_id}`, [c.content]);
      authors.set(`comment:${c.platform_comment_id}`, c.author.platform_user_id);
      comments.push(c.content);
      walk(c.sub_comments ?? []);
    }
  };
  for (const n of corpus.notes) {
    sources.set(`note:${n.platform_post_id}`, [n.title, n.content]);
    walk(n.comments);
  }
  return { sources, authors, comments };
}

function assertEvidenceVerbatim(brief: ResearchBrief, sources: Map<string, string[]>): number {
  let checked = 0;
  for (const insight of brief.findings.insights) {
    assert.ok(insight.evidence.length > 0, `insight without evidence: ${insight.text}`);
    for (const e of insight.evidence) {
      assert.ok(e.quote && e.source_ref, 'evidence must quote a referenced source');
      const texts = sources.get(e.source_ref);
      assert.ok(texts, `unknown source ${e.source_ref}`);
      assert.ok(texts.some((t) => t.includes(e.quote!)), `"${e.quote}" is not verbatim in ${e.source_ref}`);
      checked++;
    }
  }
  return checked;
}

function simSetup() {
  const ctx = createTestContext();
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  const s = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(s, 'hz-bmw') };
}

let seq = 0;
function seedPost(ctx: ReturnType<typeof createTestContext>, title: string, content: string, publishedAt: string): PublicPost {
  seq++;
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `xhs-seed-note-${seq}`,
    xsec_token: null,
    url: null,
    title,
    content,
    author_platform_user_id: `xhs-seed-author-${seq}`,
    author_nickname: '杭州试驾博主',
    author_profile_url: null,
    ip_location: '浙江',
    tags: [],
    like_count: 120,
    comment_count: 3,
    collect_count: 30,
    published_at: publishedAt,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

function seedComment(ctx: ReturnType<typeof createTestContext>, post: PublicPost, content: string, author: string) {
  seq++;
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `xhs-seed-cmt-${seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: author,
    author_nickname: '网友',
    content,
    ip_location: '浙江',
    like_count: 1,
    published_at: '2026-09-11T02:00:00.000Z',
    prefilter_passed: false,
    prefilter_reason: '',
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

describe('xhs-research: simulation corpus', () => {
  it('produces evidence-backed buyer questions and topics from bounded searches without persisting public content', async () => {
    const { ctx, hz } = simSetup();
    const index = corpusIndex();
    const brief = await runXhsResearch(ctx, { dealer_id: hz });

    assert.deepEqual(ctx.db.table('research_briefs').require(brief.id), brief, 'returned brief is the persisted row');
    assert.equal(brief.kind, 'xhs');
    assert.equal(brief.engine, 'rules');
    assert.equal(brief.workflow_run_id, null);
    assert.equal(brief.dealer_id, hz);
    assert.deepEqual(brief.scope.models.slice(0, 2), ['i3', 'X3']);
    assert.ok(brief.source_counts.provider_searches > 0 && brief.source_counts.provider_searches <= MAX_PROVIDER_QUERIES);
    assert.ok(brief.source_counts.posts > 0 && brief.source_counts.comments > 0);
    assert.ok(brief.findings.headline.startsWith('【模拟数据】'), 'simulation data is labelled');

    const questions = brief.findings.top_questions ?? [];
    assert.ok(questions.length > 0, 'buyer question clusters found');
    for (let i = 1; i < questions.length; i++) assert.ok(questions[i - 1].count >= questions[i].count, 'sorted by count');
    for (const q of questions) {
      assert.ok(q.count >= 1);
      assert.ok(index.comments.some((c) => c.includes(q.example_quote)), `example "${q.example_quote}" is a verbatim corpus comment`);
    }
    assert.ok((brief.findings.topics ?? []).length > 0);
    assert.ok(brief.findings.insights.length > 0);
    assert.ok(assertEvidenceVerbatim(brief, index.sources) > 0);

    assert.equal(ctx.db.table('public_posts').count(), 0, 'research never ingests provider notes');
    assert.equal(ctx.db.table('public_comments').count(), 0);

    const decision = ctx.db.table('agent_decisions').findOne({ subject_type: 'research_brief', subject_id: brief.id });
    assert.ok(decision);
    assert.equal(decision.decision_type, 'research');
    assert.equal(decision.agent, 'research-agent');
    assert.equal(decision.skill, 'xhs-research');
    assert.equal(decision.engine, 'rules');
    assert.ok(decision.confidence > 0 && decision.confidence <= 0.9);
    const inputs = decision.inputs as { queries: string[]; provider: { mode: string; queries: unknown[] } };
    assert.ok(inputs.queries.length > 0 && inputs.queries.length <= MAX_PROVIDER_QUERIES);
    assert.equal(inputs.provider.mode, 'simulation');
    assert.equal(ctx.audit.eventsFor('research_brief', brief.id)[0]?.action, 'research.brief_created');
  });

  it('counts only buyer questions: no marketing, owner statements or managed accounts', async () => {
    const { ctx, hz } = simSetup();
    const index = corpusIndex();
    const brief = await runXhsResearch(ctx, { dealer_id: hz });
    const buyerEvidence = brief.findings.insights.flatMap((i) => i.evidence).filter((e) => e.code.startsWith('buyer_question:'));
    assert.ok(buyerEvidence.length > 0);
    for (const e of buyerEvidence) {
      const author = index.authors.get(e.source_ref!);
      assert.ok(author, `buyer question evidence must reference a comment: ${e.source_ref}`);
      assert.notEqual(author, 'u-dealer-spam-001', 'competitor salesperson spam is never a buyer question');
      assert.ok(!author.startsWith('u-owner-'), `owner remark counted as buyer question: ${e.quote}`);
      assert.ok(!author.startsWith('xhs-'), 'managed accounts are never buyers');
      const text = index.sources.get(e.source_ref!)![0];
      assert.ok(isQuestionForm(text) || text.includes('还是'), `not a question: ${text}`);
    }
    for (const q of brief.findings.top_questions ?? []) {
      assert.ok(!/私信我|私我/.test(q.example_quote), q.example_quote);
      assert.notEqual(q.example_quote, 'X3开了两年，保养也不贵，推荐');
    }
  });

  it('stamps the workflow run on the brief and the decision', async () => {
    const { ctx, hz } = simSetup();
    const runCtx = withRun(ctx, 'run_xhs_research_1');
    const brief = await runXhsResearch(runCtx, { dealer_id: hz, window_days: 30 });
    assert.equal(brief.workflow_run_id, 'run_xhs_research_1');
    assert.equal(ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })?.workflow_run_id, 'run_xhs_research_1');
  });

  it('scopes explicit models and aliases', async () => {
    const { ctx, hz } = simSetup();
    const brief = await runXhsResearch(ctx, { dealer_id: hz, models: ['宝马X3'] });
    assert.deepEqual(brief.scope.models, ['X3']);
    const decision = ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })!;
    for (const q of (decision.inputs as { queries: string[] }).queries) assert.ok(q.includes('X3') || q.includes('宝马'), q);
  });

  it('is honest when the provider finds nothing relevant inside a short window', async () => {
    const { ctx, hz } = simSetup();
    const brief = await runXhsResearch(ctx, { dealer_id: hz, window_days: 1 });
    assert.ok(brief.source_counts.provider_searches > 0);
    assert.equal(brief.source_counts.posts, 0);
    assert.equal(brief.source_counts.comments, 0);
    assert.deepEqual(brief.findings.insights, []);
    assert.ok(brief.findings.headline.includes('未返回'), brief.findings.headline);
  });
});

describe('xhs-research: DB corpus and empty data', () => {
  it('analyses already-ingested posts when search is unavailable and says so', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const post = seedPost(ctx, '宝马i3试驾体验', '周末去试驾了i3，续航很稳', '2026-09-10T02:00:00.000Z');
    const question = seedComment(ctx, post, '现在i3优惠多少', 'u-seed-buyer');
    seedComment(ctx, post, '好帅', 'u-seed-fan');
    seedComment(ctx, post, '需要优惠的私我', 'u-seed-spam');

    const brief = await runXhsResearch(ctx, { dealer_id: hz });
    assert.deepEqual(brief.source_counts, { posts: 1, comments: 3, provider_searches: 0 });
    assert.ok(brief.findings.headline.includes('小红书搜索当前不可用'), brief.findings.headline);
    assert.ok(!brief.findings.headline.includes('模拟数据'));
    const discount = brief.findings.top_questions?.find((q) => q.question === '现在优惠多少');
    assert.deepEqual(discount, { question: '现在优惠多少', count: 1, example_quote: '现在i3优惠多少' });
    const topic = brief.findings.topics?.find((t) => t.topic === '试驾/实拍体验');
    assert.deepEqual(topic, { topic: '试驾/实拍体验', posts: 1, engagement: 153 });
    for (const e of brief.findings.insights.flatMap((i) => i.evidence).filter((x) => x.code.startsWith('buyer_question:'))) {
      assert.equal(e.source_ref, `comment:${question.platform_comment_id}`);
    }
  });

  it('persists an honest empty brief when the provider is unavailable and the DB is empty', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const brief = await runXhsResearch(ctx, { dealer_id: hz });
    assert.deepEqual(brief.source_counts, { posts: 0, comments: 0, provider_searches: 0 });
    assert.deepEqual(brief.findings.insights, []);
    assert.deepEqual(brief.findings.top_questions, []);
    assert.deepEqual(brief.findings.topics, []);
    assert.ok(brief.findings.headline.startsWith('暂无可分析的小红书公开数据'), brief.findings.headline);
    assert.ok(brief.findings.headline.includes('UNAVAILABLE'));
    assert.equal(ctx.db.table('research_briefs').count({ dealer_id: hz, kind: 'xhs' }), 1);
    assert.equal(ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })?.confidence, 0);
  });
});

describe('xhs-research: helpers and skill', () => {
  it('classifies titles into multi-label topics', () => {
    assert.deepEqual(topicsOfTitle('X3和GLC选哪个？30万豪华SUV深度对比'), ['车型对比', '提问式标题']);
    assert.ok(topicsOfTitle('第一次买宝马｜4S店砍价全过程，落地价公开').includes('价格/落地价/优惠'));
    assert.deepEqual(topicsOfTitle('杭州周末去哪儿'), ['其他']);
  });

  it('runs through the registry with validated input and output', async () => {
    const { ctx, hz } = simSetup();
    const registry = new SkillRegistry().register(skill);
    const brief = await registry.invoke<ResearchBrief>(ctx, 'xhs-research', { dealer_id: hz, window_days: 30 });
    assert.equal(brief.kind, 'xhs');
    await assert.rejects(registry.invoke(ctx, 'xhs-research', { dealer_id: hz, window_days: 'x' }), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'xhs-research', { models: ['i3'] }), ValidationError);
  });
});
