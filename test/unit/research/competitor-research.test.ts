import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ResearchBrief } from '../../../src/core/types.ts';
import { competitorsOf, mapText } from '../../../src/domain/automotive-lexicon.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimComment } from '../../../src/providers/xhs/simulation.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import {
  analyzeCompetitorCorpus,
  findSentimentCues,
  runCompetitorResearch,
  skill,
} from '../../../src/skills/research/competitor-research/index.ts';
import { resolveScope, type ResearchComment, type ResearchCorpus, type ResearchNote } from '../../../src/skills/research/shared.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

function corpusSources(): { sources: Map<string, string[]>; authors: Map<string, string> } {
  const corpus = JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')) as {
    notes: { platform_post_id: string; title: string; content: string; comments: SimComment[] }[];
  };
  const sources = new Map<string, string[]>();
  const authors = new Map<string, string>();
  const walk = (list: SimComment[]) => {
    for (const c of list) {
      sources.set(`comment:${c.platform_comment_id}`, [c.content]);
      authors.set(`comment:${c.platform_comment_id}`, c.author.platform_user_id);
      walk(c.sub_comments ?? []);
    }
  };
  for (const n of corpus.notes) {
    sources.set(`note:${n.platform_post_id}`, [n.title, n.content]);
    walk(n.comments);
  }
  return { sources, authors };
}

const cues = (text: string) => findSentimentCues(mapText(text)).map((h) => h.cue);

function note(p: Partial<ResearchNote> & { platform_post_id: string; title: string }): ResearchNote {
  return {
    public_post_id: null,
    origin: 'provider',
    content: '',
    tags: [],
    author_user_id: 'u-author',
    author_nickname: '作者',
    ip_location: '浙江',
    like_count: 0,
    collect_count: 0,
    comment_count: 0,
    published_at: TEST_NOW,
    observed_at: TEST_NOW,
    own_post_id: null,
    managed_author: false,
    data_mode: 'import',
    comments: [],
    ...p,
  };
}

function comment(id: string, content: string): ResearchComment {
  return {
    platform_comment_id: id,
    public_comment_id: null,
    parent_comment_id: null,
    author_user_id: `u-${id}`,
    author_nickname: '网友',
    content,
    ip_location: '浙江',
    like_count: 0,
    published_at: TEST_NOW,
    observed_at: TEST_NOW,
    managed_author: false,
    note_author: false,
    data_mode: 'import',
  };
}

function corpusOf(notes: ResearchNote[]): ResearchCorpus {
  return {
    notes,
    provider: { provider: 'test', mode: 'none', search_status: 'NOT_QUERIED', reason: '', queries: [], searches: 0, notes: 0, comments: 0 },
    db: { posts: notes.length, comments: notes.reduce((s, n) => s + n.comments.length, 0) },
    lookback: { from: '2026-08-13T02:00:00.000Z', to: TEST_NOW, days: 30 },
  };
}

describe('competitor-research: simulation corpus', () => {
  it('finds lexicon competitors discussed with our models, with verbatim quotes and sentiment cues', async () => {
    const ctx = createTestContext();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const { sources, authors } = corpusSources();
    const brief = await runCompetitorResearch(ctx, { dealer_id: hz });

    assert.equal(brief.kind, 'competitor');
    assert.ok(brief.source_counts.provider_searches > 0);
    const rows = brief.findings.competitors ?? [];
    const row = (model: string, our: string) => rows.find((r) => r.model === model && r.comparison_with === our);
    assert.ok((row('Model 3', 'i3')?.mentions ?? 0) >= 2, 'i3 vs Model 3');
    assert.ok((row('GLC', 'X3')?.mentions ?? 0) >= 2, 'X3 vs GLC');
    assert.ok((row('C-Class', '3 Series')?.mentions ?? 0) >= 2, '3系 vs C级');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].mentions >= rows[i].mentions);
    for (const r of rows) {
      assert.ok(competitorsOf('BMW', r.comparison_with).some((c) => c.model === r.model), `${r.model} is a lexicon competitor of ${r.comparison_with}`);
      assert.ok([...sources.values()].some((texts) => texts.some((t) => t.includes(r.example_quote))), `example "${r.example_quote}" verbatim`);
    }

    for (const insight of brief.findings.insights) {
      for (const e of insight.evidence) {
        const texts = sources.get(e.source_ref!);
        assert.ok(texts && texts.some((t) => t.includes(e.quote!)), `"${e.quote}" verbatim in ${e.source_ref}`);
        assert.notEqual(authors.get(e.source_ref!), 'u-dealer-spam-001');
      }
    }
    const pairInsight = brief.findings.insights.find((i) => i.text.startsWith('「i3 vs Model 3」'));
    assert.ok(pairInsight);
    const [, mentions, comparisons] = /同框讨论(\d+)次（其中明确对比(\d+)次）/.exec(pairInsight.text)!.map(Number);
    assert.ok(comparisons >= 1 && comparisons <= mentions);

    const sentiment = brief.findings.insights.find((i) => i.text.startsWith('情绪词：Model Y'));
    assert.ok(sentiment, 'Model Y is called 香 by owners in the corpus');
    assert.ok(sentiment.text.includes('「香」'));
    for (const e of sentiment.evidence) assert.ok(e.quote!.includes('香'));
    assert.ok(brief.findings.headline.startsWith('【模拟数据】'));
    assert.equal(ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })?.skill, 'competitor-research');
  });
});

describe('competitor-research: pure analysis', () => {
  it('counts direct and thread co-mentions, attributes cues to the nearest model and skips questions', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const scope = resolveScope(ctx, { dealer_id: hz, models: ['X3'] });
    const corpus = corpusOf([
      note({
        platform_post_id: 'n1',
        title: '宝马X3和奥迪Q5L怎么选？',
        content: '家用SUV纠结中',
        comments: [
          comment('k1', '已经提了Q5L，真香'),
          comment('k2', 'X3开着更爽，买了不后悔'),
          comment('k3', '提了Q5L有点后悔'),
          comment('k4', '宝马X3值得买吗？'),
          comment('k5', 'Q5L不值这个价'),
        ],
      }),
    ]);
    const findings = analyzeCompetitorCorpus(corpus, scope);
    const q5l = findings.competitors?.find((c) => c.model === 'Q5L');
    assert.ok(q5l);
    assert.equal(q5l.brand, 'Audi');
    assert.equal(q5l.comparison_with, 'X3');
    assert.equal(q5l.mentions, 4, 'note + three comments naming Q5L under an X3 thread');
    assert.equal(q5l.example_quote, '宝马X3和奥迪Q5L怎么选？', 'an explicit comparison is the preferred example');

    const q5lSentiment = findings.insights.find((i) => i.text.startsWith('情绪词：Q5L'));
    assert.ok(q5lSentiment);
    assert.ok(q5lSentiment.text.includes('「香」1次') && q5lSentiment.text.includes('「后悔」1次') && q5lSentiment.text.includes('「不值」1次'), q5lSentiment.text);
    assert.ok(q5lSentiment.text.includes('正向1次、负向2次'));
    const x3Sentiment = findings.insights.find((i) => i.text.startsWith('情绪词：X3'));
    assert.ok(x3Sentiment && x3Sentiment.text.includes('「不后悔」1次'), String(x3Sentiment?.text));
    assert.ok(!x3Sentiment.text.includes('「值」'), 'a question clause is never sentiment');
    assert.ok(findings.headline.includes('Q5L'));
  });

  it('detects sentiment cues with question and negation handling', () => {
    assert.deepEqual(cues('已经提了Model Y 很香'), ['香']);
    assert.deepEqual(cues('宝马i3现在值得买吗？'), []);
    assert.deepEqual(cues('i3值得买吗？我个人觉得值得'), ['值']);
    assert.deepEqual(cues('这车不值这个价'), ['不值']);
    assert.deepEqual(cues('买了不后悔'), ['不后悔']);
    assert.deepEqual(cues('有点后悔没等等'), ['后悔']);
    assert.deepEqual(cues('值不值得入手'), []);
    assert.deepEqual(cues('不吃香菜'), []);
  });

  it('writes an honest empty brief without any public data', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const registry = new SkillRegistry().register(skill);
    const brief = await registry.invoke<ResearchBrief>(ctx, 'competitor-research', { dealer_id: hz });
    assert.deepEqual(brief.findings.insights, []);
    assert.deepEqual(brief.findings.competitors, []);
    assert.deepEqual(brief.source_counts, { posts: 0, comments: 0, provider_searches: 0 });
    assert.ok(brief.findings.headline.startsWith('暂无可分析的小红书公开数据'));
  });
});
