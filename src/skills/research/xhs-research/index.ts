/**
 * Xiaohongshu research (B3): what buyers ask, which content topics earn engagement, and which formats attract
 * buyer questions rather than just likes — evidence-based, over a bounded provider search plus ingested data.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Evidence, ResearchBrief, ResearchInsight } from '../../../core/types.ts';
import { defineSkill } from '../../registry.ts';
import {
  QUESTION_CLUSTERS,
  analyzeComments,
  assertBriefShape,
  buildResearchQueries,
  clauseAround,
  commentEvidence,
  corpusCounts,
  dataBasisNote,
  excerpt,
  exampleOrder,
  gatherResearchCorpus,
  modelsLabel,
  namesOnlyOutOfScopeModels,
  noDataHeadline,
  noteEvidence,
  pct,
  persistBrief,
  questionClustersOf,
  researchInputValidator,
  resolveScope,
  simulationPrefix,
  type AnalyzedComment,
  type QuestionClusterKey,
  type ResearchCorpus,
  type ResearchInput,
  type ResearchNote,
  type ResearchScope,
} from '../shared.ts';

export const SKILL_NAME = 'xhs-research';

/** Title patterns (normalized title). A note may belong to several topics; unmatched notes are '其他'. */
export const TOPIC_PATTERNS: readonly { topic: string; re: RegExp }[] = [
  { topic: '车型对比', re: /vs|还是|怎么选|选哪个|选哪台|对比|pk|二选一|纠结/ },
  { topic: '价格/落地价/优惠', re: /落地|价格|报价|多少钱|砍价|优惠|底价|政策/ },
  { topic: '金融/置换', re: /贷款|金融|分期|置换|以租代购|首付|月供/ },
  { topic: '购车攻略/避坑', re: /攻略|必看|避坑|清单|几件事|指南|流程|怎么谈|注意/ },
  { topic: '试驾/实拍体验', re: /试驾|体验|实拍|测评|评测/ },
  { topic: '车主/提车故事', re: /提车|车主|开了|真实感受|第一台|提啦/ },
  { topic: '到店/现车', re: /到店|现车|店里/ },
  { topic: '提问式标题', re: /[?]|吗|求推荐|推荐一下/ },
];

export function topicsOfTitle(title: string): string[] {
  const t = title.normalize('NFKC').toLowerCase();
  const hits = TOPIC_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.topic);
  return hits.length > 0 ? hits : ['其他'];
}

export const engagementOf = (n: Pick<ResearchNote, 'like_count' | 'collect_count' | 'comment_count'>) =>
  n.like_count + n.collect_count + n.comment_count;

interface ClusterStat {
  key: QuestionClusterKey;
  label: string;
  items: { item: AnalyzedComment; keyword: string | null }[];
}

interface TopicStat {
  topic: string;
  notes: ResearchNote[];
  engagement: number;
  likes: number;
  buyer_questions: AnalyzedComment[];
}

function questionQuote(item: AnalyzedComment, keyword: string | null): string {
  return (keyword ? clauseAround(item.comment.content, keyword) : null) ?? excerpt(item.comment.content);
}

const avg = (total: number, n: number) => (n > 0 ? Math.round((total / n) * 10) / 10 : 0);

/** Pure analysis of a gathered corpus (exported for reuse and tests). */
export function analyzeXhsCorpus(corpus: ResearchCorpus, scope: ResearchScope): ResearchBrief['findings'] {
  const counts = corpusCounts(corpus);
  if (counts.posts === 0 && counts.comments === 0) return { headline: noDataHeadline(scope, corpus), insights: [], top_questions: [], topics: [] };

  const analyzed = analyzeComments(corpus, scope);
  // a buyer question about another model under a relevant note ('上海X3现在什么价' in an i3 brief) is not this scope's demand
  const questions = analyzed.filter((a) => a.question && !namesOnlyOutOfScopeModels(scope, a.comment.content));

  // ── buyer question clusters ─────────────────────────────────────────────────
  const clusters = new Map<QuestionClusterKey, ClusterStat>();
  for (const item of questions) {
    for (const { key, keyword } of questionClustersOf(item)) {
      let stat = clusters.get(key);
      if (!stat) {
        stat = { key, label: QUESTION_CLUSTERS.find((c) => c.key === key)?.label ?? key, items: [] };
        clusters.set(key, stat);
      }
      stat.items.push({ item, keyword });
    }
  }
  const clusterOrder = (k: QuestionClusterKey) => QUESTION_CLUSTERS.findIndex((c) => c.key === k);
  const ranked = [...clusters.values()]
    .map((c) => ({ ...c, items: [...c.items].sort((a, b) => exampleOrder(a.item, b.item)) }))
    .sort((a, b) => b.items.length - a.items.length || clusterOrder(a.key) - clusterOrder(b.key));
  const top_questions = ranked.map((c) => ({ question: c.label, count: c.items.length, example_quote: excerpt(c.items[0].item.comment.content) }));

  // ── topics by engagement ────────────────────────────────────────────────────
  const topicMap = new Map<string, TopicStat>();
  for (const note of corpus.notes) {
    for (const topic of topicsOfTitle(note.title || excerpt(note.content, 30))) {
      let stat = topicMap.get(topic);
      if (!stat) {
        stat = { topic, notes: [], engagement: 0, likes: 0, buyer_questions: [] };
        topicMap.set(topic, stat);
      }
      stat.notes.push(note);
      stat.engagement += engagementOf(note);
      stat.likes += note.like_count;
      stat.buyer_questions.push(...questions.filter((q) => q.note === note));
    }
  }
  const topicsRanked = [...topicMap.values()].sort((a, b) => b.engagement - a.engagement || a.topic.localeCompare(b.topic));
  const topics = topicsRanked.map((t) => ({ topic: t.topic, posts: t.notes.length, engagement: t.engagement }));

  // ── insights ────────────────────────────────────────────────────────────────
  const insights: ResearchInsight[] = [];
  for (const c of ranked.slice(0, 3)) {
    insights.push({
      text: `买家最常问「${c.label}」：${c.items.length}条评论，占买家提问的${pct(c.items.length, questions.length)}%`,
      metric: c.items.length,
      evidence: c.items.slice(0, 3).map(({ item, keyword }) => commentEvidence(`buyer_question:${c.key}`, c.label, item.comment, questionQuote(item, keyword))),
    });
  }

  const namedTopics = topicsRanked.filter((t) => t.topic !== '其他');
  const topTopic = namedTopics[0] ?? topicsRanked[0];
  if (topTopic && topTopic.engagement > 0) {
    const notes = [...topTopic.notes].sort((a, b) => engagementOf(b) - engagementOf(a));
    insights.push({
      text: `互动最高的内容主题是「${topTopic.topic}」：${topTopic.notes.length}篇笔记，点赞+收藏+评论合计${topTopic.engagement}`,
      metric: topTopic.engagement,
      evidence: notes.slice(0, 3).map((n) => noteEvidence('topic_engagement', `${topTopic.topic}（互动${engagementOf(n)}）`, n, excerpt(n.title))),
    });
  }

  if (questions.length > 0 && namedTopics.length > 0) {
    const perPost = (t: TopicStat) => ({ likes: avg(t.likes, t.notes.length), questions: avg(t.buyer_questions.length, t.notes.length) });
    const likesLeader = [...namedTopics].sort((a, b) => perPost(b).likes - perPost(a).likes || a.topic.localeCompare(b.topic))[0];
    const questionLeader = [...namedTopics].sort((a, b) => perPost(b).questions - perPost(a).questions || a.topic.localeCompare(b.topic))[0];
    if (questionLeader.buyer_questions.length > 0) {
      const likeNote = [...likesLeader.notes].sort((a, b) => b.like_count - a.like_count)[0];
      const evidence: Evidence[] = [noteEvidence('format_likes', `「${likesLeader.topic}」点赞${likeNote.like_count}`, likeNote, excerpt(likeNote.title))];
      for (const q of [...questionLeader.buyer_questions].sort(exampleOrder).slice(0, 2)) {
        evidence.push(commentEvidence('format_buyer_questions', `「${questionLeader.topic}」下的买家提问`, q.comment, excerpt(q.comment.content)));
      }
      const l = perPost(likesLeader);
      const q = perPost(questionLeader);
      insights.push({
        text:
          likesLeader.topic === questionLeader.topic
            ? `「${likesLeader.topic}」类笔记平均点赞${l.likes}/篇，同时平均引来${q.questions}条买家提问/篇，兼顾互动与获客`
            : `「${likesLeader.topic}」类笔记平均点赞最高（${l.likes}/篇），但平均引来买家提问最多的是「${questionLeader.topic}」类笔记（${q.questions}条/篇）：获客内容应优先参考「${questionLeader.topic}」`,
        metric: q.questions,
        evidence,
      });
    }
  }

  const prefix = simulationPrefix(corpus);
  const questionPart = ranked[0] ? `买家最常问「${ranked[0].label}」（${ranked[0].items.length}条）` : '未发现明确的买家提问';
  const topicPart = topTopic && topTopic.engagement > 0 ? `；互动最高的主题是「${topTopic.topic}」` : '';
  const headline = `${prefix}近${scope.window_days}天分析${counts.posts}篇笔记、${counts.comments}条评论（${modelsLabel(scope)}）：${questionPart}${topicPart}${dataBasisNote(corpus)}。`;
  return { headline, insights, top_questions, topics };
}

export async function runXhsResearch(ctx: AppContext, input: ResearchInput): Promise<ResearchBrief> {
  const scope = resolveScope(ctx, input);
  const queries = buildResearchQueries('xhs', scope);
  const corpus = await gatherResearchCorpus(ctx, scope, queries);
  const findings = analyzeXhsCorpus(corpus, scope);
  return persistBrief(ctx, { kind: 'xhs', skill: SKILL_NAME, scope, corpus, findings, queries });
}

export const skill = defineSkill<ResearchInput, ResearchBrief>({
  name: SKILL_NAME,
  category: 'research',
  agent: 'research-agent',
  description:
    '小红书内容调研：有限次数搜索本店车型/城市相关笔记与评论（并合并已采集数据），统计买家高频提问、内容主题互动与“带来提问的内容形式”，全部附逐字证据并保存调研简报。',
  input: researchInputValidator,
  run(ctx, input) {
    return runXhsResearch(ctx, input);
  },
  validateOutput: assertBriefShape,
});
