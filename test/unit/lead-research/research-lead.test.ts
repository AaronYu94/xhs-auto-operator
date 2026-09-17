import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import { newId } from '../../../src/core/ids.ts';
import type { IntentDetection, XhsCapability } from '../../../src/core/types.ts';
import { buildDealerProfile } from '../../../src/domain/dealer-profile.ts';
import { SimulationXhsProvider, type SimulationCorpus } from '../../../src/providers/xhs/simulation.ts';
import type { ProviderFailure, XhsProvider, XhsUserProfile } from '../../../src/providers/xhs/types.ts';
import { UnavailableXhsProvider, buildReport } from '../../../src/providers/xhs/unavailable.ts';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import {
  INDUSTRY_EVIDENCE_LABEL,
  detectIndustryAccount,
  researchLead,
  skill,
  type LeadResearchResult,
} from '../../../src/skills/acquisition/lead-research/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedSuppression } from '../../helpers/fixtures.ts';

const HOUR_MS = 3_600_000;
const ago = (ctx: TestContext, hours: number): string => new Date(ctx.clock.now().getTime() - hours * HOUR_MS).toISOString();

function setup(provider: 'simulation' | 'none' = 'simulation') {
  const ctx = createTestContext();
  if (provider === 'simulation') ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw') };
}

const landing = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: {
    brand: 'BMW',
    model: 'i3',
    trim: 'eDrive35L',
    location: '杭州',
    province: '浙江',
    price_intent: true,
    purchase_stage: 'active_shopping',
    confidence: 0.81,
  },
  evidence: [
    { code: 'specified_trim', label: '指定配置 eDrive35L', quote: '35L' },
    { code: 'stated_location', label: '本地买家（杭州）', quote: '杭州' },
    { code: 'landing_price', label: '询问落地价', quote: '落地多少' },
  ],
  transaction_questions: ['landing_price'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

/** A QUALIFIED lead created from an imported signal (no public post). */
function seedLead(ctx: TestContext, dealerId: string, userId: string, username = '看车用户') {
  return upsertLeadFromSignal(ctx, {
    dealer_id: dealerId,
    identity: { platform_user_id: userId, username },
    signal: { source_type: 'import', content: '杭州i3 35L落地多少', signal_at: ago(ctx, 5), detection: landing() },
  }).lead;
}

function researchDecisions(ctx: TestContext, leadId: string) {
  return ctx.audit.decisionsFor('lead', leadId).filter((d) => d.decision_type === 'lead_research');
}

function scriptedProvider(ctx: TestContext, profile: XhsUserProfile | Error, opts: { capability?: 'AVAILABLE' | 'REQUIRES_AUTH' } = {}): XhsProvider {
  const fail = async (): Promise<ProviderFailure> => ({ ok: false, status: 'UNAVAILABLE', reason: 'not scripted' });
  const status = opts.capability ?? 'AVAILABLE';
  return {
    name: 'scripted',
    mode: 'manual',
    capabilities: async (accountId?: string | null) =>
      buildReport('scripted', 'manual', accountId ?? null, ctx.clock, {
        read_public_profile: { status, reason: status === 'AVAILABLE' ? 'scripted profile' : 'login required' },
      } as Partial<Record<XhsCapability, { status: typeof status; reason: string }>>),
    searchNotes: fail,
    getNote: fail,
    getComments: fail,
    getUserProfile: async () => {
      if (profile instanceof Error) throw profile;
      return { ok: true, data: profile };
    },
    publishNote: fail,
    getEngagement: fail,
    replyToComment: fail,
    listInboundMessages: fail,
    sendMessage: fail,
  };
}

describe('lead-research · detectIndustryAccount', () => {
  it('detects dealer/sales keywords in bio and nickname with verbatim quotes', () => {
    const spam = detectIndustryAccount({ nickname: '宝马顾问小陈', bio: '杭州某宝马4S店销售顾问｜买车找我' });
    assert.equal(spam.industry, true);
    assert.deepEqual(spam.keywords, ['4S店', '销售顾问', '买车找我']);
    assert.equal(spam.evidence?.code, 'industry_account');
    assert.equal(spam.evidence?.label, INDUSTRY_EVIDENCE_LABEL);
    assert.equal(spam.evidence?.quote, '杭州某宝马4S店销售顾问');

    const nicknameOnly = detectIndustryAccount({ nickname: '二手车小刘', bio: '杭州｜每天分享' });
    assert.equal(nicknameOnly.industry, true);
    assert.equal(nicknameOnly.evidence?.quote, '二手车小刘');

    const fullWidth = detectIndustryAccount({ nickname: '阿杰', bio: '４Ｓ店十年老兵，私信报价' });
    assert.deepEqual(fullWidth.keywords, ['4S店', '私信报价']);
    assert.ok(isVerbatimQuote('４Ｓ店十年老兵，私信报价', fullWidth.evidence?.quote));

    for (const buyer of [{ nickname: '西湖边的小鹿', bio: '杭州｜准备换电车' }, { nickname: '路过的猫', bio: null }, {}]) {
      const res = detectIndustryAccount(buyer);
      assert.equal(res.industry, false);
      assert.deepEqual(res.keywords, []);
      assert.equal(res.evidence, null);
    }
  });
});

describe('lead-research · researchLead with the simulation provider', () => {
  it('closes a competitor salesperson (u-dealer-spam-001) as an industry account', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-dealer-spam-001', '宝马顾问小陈');
    assert.equal(lead.stage, 'QUALIFIED');
    const before = ctx.db.table('leads').require(lead.id);

    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'researched');
    assert.equal(res.industry_account, true);
    assert.equal(res.authenticity.score, 0);
    assert.equal(res.added_signals, 0);
    assert.ok(res.reason.includes('4S店'), res.reason);

    const after = ctx.db.table('leads').require(lead.id);
    assert.equal(after.stage, 'LOST');
    assert.equal(after.lost_reason, 'industry_account');
    const ev = after.evidence.find((e) => e.code === 'industry_account');
    assert.ok(ev);
    assert.equal(ev.label, '疑似车商/销售账号');
    assert.ok(isVerbatimQuote('杭州某宝马4S店销售顾问｜买车找我', ev.quote), `quote from bio: ${ev.quote}`);
    assert.equal(ev.source_ref, 'profile:u-dealer-spam-001');
    assert.ok(!after.evidence.some((e) => e.code === 'verified_local_user'));
    assert.ok(after.score < before.score, `score ${before.score} → ${after.score}`);
    const latestRow = ctx.db.get('SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY computed_at DESC, rowid DESC LIMIT 1', lead.id);
    assert.ok(latestRow);
    const latest = ctx.db.table('lead_scores').decode(latestRow);
    assert.equal(latest.components.find((c) => c.factor === 'authenticity')?.points, 0);

    const transition = ctx.db.table('lead_stage_transitions').findOne({ lead_id: lead.id, to_stage: 'LOST' });
    assert.equal(transition?.actor, 'agent:lead-research-agent');
    assert.equal(transition?.reason, 'industry_account');

    const [decision] = researchDecisions(ctx, lead.id);
    assert.equal(decision.agent, 'lead-research-agent');
    assert.equal(decision.output.status, 'researched');
    assert.ok((decision.output.industry_keywords as string[]).includes('销售顾问'));
    assert.equal((decision.inputs.profile as { nickname: string }).nickname, '宝马顾问小陈');
    assert.equal((decision.inputs.profile as { ip_location: string }).ip_location, '浙江');
    assert.equal(decision.output.stage_after, 'LOST');
    assert.deepEqual(decision.evidence.map((e) => e.code), ['industry_account']);

    // idempotent: a second research adds no evidence and no transition
    const again = await researchLead(ctx, lead.id);
    assert.equal(again.industry_account, true);
    assert.equal(ctx.db.table('leads').require(lead.id).evidence.filter((e) => e.code === 'industry_account').length, 1);
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id, to_stage: 'LOST' }), 1);
  });

  it('keeps the stage of an industry account that is already in a sales conversation', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-dealer-spam-001');
    transitionLead(ctx, lead.id, 'CONTACTED', { reason: '已私信', actor: 'operator:tester' });
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.industry_account, true);
    const after = ctx.db.table('leads').require(lead.id);
    assert.equal(after.stage, 'CONTACTED');
    assert.ok(after.evidence.some((e) => e.code === 'industry_account'));
  });

  it('marks u-hz-buyer-001 as a verified local user and uses the observed xsec_token', async () => {
    const { ctx, hz } = setup();
    const now = ctx.clock.iso();
    const post = ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: 'note-i3-worth-001',
      xsec_token: 'ABsimI3worth001x9Kd=',
      url: null,
      title: '宝马i3现在值得买吗？',
      content: '',
      author_platform_user_id: 'u-kol-ev-001',
      author_nickname: '电车老司机阿杰',
      author_profile_url: null,
      ip_location: '上海',
      tags: [],
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      published_at: now,
      own_post_id: null,
      first_search_run_id: null,
      fetched_at: now,
      raw: {},
    });
    const lead = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-hz-buyer-001', username: '西湖边的小鹿' },
      signal: { source_type: 'comment', public_post_id: post.id, post_title: post.title, content: '杭州i3 35L落地多少', signal_at: ago(ctx, 30), detection: landing() },
    }).lead;
    const before = ctx.db.table('leads').require(lead.id);

    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'researched');
    assert.equal(res.industry_account, false);
    assert.equal(res.authenticity.score, 5);
    assert.equal(res.added_signals, 0);

    const after = ctx.db.table('leads').require(lead.id);
    const ev = after.evidence.find((e) => e.code === 'verified_local_user');
    assert.ok(ev);
    assert.equal(ev.label, '本地真实用户（IP属地 浙江）');
    assert.equal(ev.quote, '浙江');
    assert.equal(after.stage, before.stage, 'stage untouched');
    assert.ok(after.score >= before.score);
    assert.equal(after.profile_url, 'https://www.xiaohongshu.com/user/profile/u-hz-buyer-001');
    const [decision] = researchDecisions(ctx, lead.id);
    assert.equal(decision.inputs.xsec_token_used, true);
    assert.equal(decision.output.verified_local_user, true);
    assert.ok(ctx.audit.eventsFor('lead', lead.id).some((e) => e.action === 'lead.researched'));
  });

  it('keeps default authenticity for a genuine user outside the dealer province', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-gd-buyer-001');
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'researched');
    assert.equal(res.authenticity.score, 4);
    assert.equal(res.industry_account, false);
    assert.ok(res.reason.includes('广东'), res.reason);
    assert.ok(!ctx.db.table('leads').require(lead.id).evidence.some((e) => e.code === 'verified_local_user' || e.code === 'industry_account'));
  });

  it('adds purchase signals from recent profile notes exactly once (canonical corpus)', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-hz-author-001', '二胎妈妈Luna');
    const title = '预算30万，杭州，家用SUV推荐？X3还是Q5L';
    const detection = detectIntentRules(title, { source_type: 'profile', author_nickname: '二胎妈妈Luna', ip_location: '浙江' }, buildDealerProfile(ctx, hz));
    const expected = detection.is_purchase_signal && !detection.negative ? 1 : 0;

    const first = await researchLead(ctx, lead.id);
    assert.equal(first.added_signals, expected);
    const profileSignals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id, source_type: 'profile' });
    assert.equal(profileSignals.length, expected);
    if (expected === 1) {
      assert.equal(profileSignals[0].content, title);
      assert.equal(profileSignals[0].public_post_id, null);
      assert.equal(profileSignals[0].signal_at, '2026-09-10T13:20:00.000Z');
    }
    const countAfterFirst = ctx.db.table('leads').require(lead.id).signal_count;

    const second = await researchLead(ctx, lead.id);
    assert.equal(second.added_signals, 0);
    assert.equal(ctx.db.table('leads').require(lead.id).signal_count, countAfterFirst);
    assert.equal(researchDecisions(ctx, lead.id).length, 2);
  });

  it('adds a strong recent-note signal from a custom corpus, skips notes already captured', async () => {
    const ctx = createTestContext();
    const corpus: SimulationCorpus = {
      notes: [
        {
          platform_post_id: 'note-custom-001',
          xsec_token: 'tok-custom-001',
          title: '杭州i3 35L白外红内有现车吗？这周想去看看',
          content: '想这周去店里看看实车',
          tags: [],
          keywords: [],
          author: { platform_user_id: 'u-custom-001', nickname: '想换车的阿明' },
          ip_location: '浙江',
          like_count: 3,
          comment_count: 0,
          collect_count: 0,
          published_at: '2026-09-11T12:00:00Z',
          comments: [],
        },
        {
          platform_post_id: 'note-custom-002',
          xsec_token: 'tok-custom-002',
          title: '周末西湖边咖啡店合集',
          content: '拍照很出片',
          tags: [],
          keywords: [],
          author: { platform_user_id: 'u-custom-001', nickname: '想换车的阿明' },
          ip_location: '浙江',
          like_count: 1,
          comment_count: 0,
          collect_count: 0,
          published_at: '2026-09-10T12:00:00Z',
          comments: [],
        },
      ],
      profiles: [
        {
          platform_user_id: 'u-custom-001',
          nickname: '想换车的阿明',
          bio: '杭州打工人',
          ip_location: '浙江',
          follower_count: 5,
          note_count: 2,
          recent_note_ids: ['note-custom-001', 'note-custom-002'],
        },
      ],
      inbox_scripts: [],
    };
    ctx.xhs = new SimulationXhsProvider(ctx.clock, corpus);
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const lead = seedLead(ctx, hz, 'u-custom-001', '想换车的阿明');

    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'researched');
    assert.equal(res.added_signals, 1);
    assert.equal(res.authenticity.score, 5);
    const profileSignal = ctx.db.table('lead_signals').findOne({ lead_id: lead.id, source_type: 'profile' });
    assert.equal(profileSignal?.content, '杭州i3 35L白外红内有现车吗？这周想去看看');
    assert.equal(profileSignal?.is_purchase_signal, true);
    const notes = researchDecisions(ctx, lead.id)[0].output.notes as { platform_post_id: string; outcome: string }[];
    assert.deepEqual(
      notes.map((n) => [n.platform_post_id, n.outcome]),
      [
        ['note-custom-001', 'added'],
        ['note-custom-002', 'not_purchase_signal'],
      ],
    );
    assert.equal((await researchLead(ctx, lead.id)).added_signals, 0);
    assert.equal(ctx.db.table('lead_signals').count({ lead_id: lead.id, source_type: 'profile' }), 1);

    // a second user whose note was already ingested as a public post signal: not duplicated as a profile signal
    const ctx2 = createTestContext();
    ctx2.xhs = new SimulationXhsProvider(ctx2.clock, corpus);
    const hz2 = dealerIdByKey(loadDealerFixture(ctx2), 'hz-bmw');
    const now = ctx2.clock.iso();
    const post = ctx2.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: 'note-custom-001',
      xsec_token: 'tok-custom-001',
      url: null,
      title: corpus.notes[0].title,
      content: corpus.notes[0].content,
      author_platform_user_id: 'u-custom-001',
      author_nickname: '想换车的阿明',
      author_profile_url: null,
      ip_location: '浙江',
      tags: [],
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      published_at: '2026-09-11T12:00:00.000Z',
      own_post_id: null,
      first_search_run_id: null,
      fetched_at: now,
      raw: {},
    });
    const postLead = upsertLeadFromSignal(ctx2, {
      dealer_id: hz2,
      identity: { platform_user_id: 'u-custom-001', username: '想换车的阿明' },
      signal: { source_type: 'post', public_post_id: post.id, post_title: post.title, content: post.content, signal_at: '2026-09-11T12:00:00.000Z', detection: landing() },
    }).lead;
    const captured = await researchLead(ctx2, postLead.id);
    assert.equal(captured.added_signals, 0);
    const outcomes = researchDecisions(ctx2, postLead.id)[0].output.notes as { outcome: string }[];
    assert.equal(outcomes[0].outcome, 'already_captured');
    assert.equal(ctx2.db.table('leads').require(postLead.id).signal_count, 1);
  });
});

describe('lead-research · skipped research never fabricates data', () => {
  it('skips with the capability reason when no Xiaohongshu provider is configured', async () => {
    const { ctx, hz } = setup('none');
    assert.ok(ctx.xhs instanceof UnavailableXhsProvider);
    const lead = seedLead(ctx, hz, 'u-hz-buyer-001');
    const before = ctx.db.table('leads').require(lead.id);
    const scoresBefore = ctx.db.table('lead_scores').count({ lead_id: lead.id });

    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'skipped');
    assert.ok(res.reason.startsWith('UNAVAILABLE: '), res.reason);
    assert.equal(res.added_signals, 0);
    assert.equal(res.industry_account, false);
    assert.equal(res.authenticity.score, 4);
    assert.deepEqual(ctx.db.table('leads').require(lead.id), before, 'lead untouched');
    assert.equal(ctx.db.table('lead_scores').count({ lead_id: lead.id }), scoresBefore);
    const [decision] = researchDecisions(ctx, lead.id);
    assert.equal(decision.output.status, 'skipped');
    assert.equal(decision.output.reason, res.reason);
    assert.deepEqual(decision.evidence, []);
    assert.equal(decision.inputs.profile, null);
  });

  it('skips when the capability requires auth, the user is unknown, the provider throws or returns another user', async () => {
    const { ctx, hz } = setup();
    const unknown = seedLead(ctx, hz, 'u-nobody-001');
    const res = await researchLead(ctx, unknown.id);
    assert.equal(res.status, 'skipped');
    assert.ok(res.reason.startsWith('UNAVAILABLE: ') && res.reason.includes('user not found'), res.reason);

    const lead = seedLead(ctx, hz, 'u-hz-buyer-002');
    const evidenceBefore = ctx.db.table('leads').require(lead.id).evidence;
    ctx.xhs = scriptedProvider(ctx, new Error('socket hang up'), { capability: 'REQUIRES_AUTH' });
    const auth = await researchLead(ctx, lead.id);
    assert.equal(auth.status, 'skipped');
    assert.equal(auth.reason, 'REQUIRES_AUTH: login required');

    ctx.xhs = scriptedProvider(ctx, new Error('socket hang up'));
    const thrown = await researchLead(ctx, lead.id);
    assert.equal(thrown.status, 'skipped');
    assert.ok(thrown.reason.includes('socket hang up'));

    ctx.xhs = scriptedProvider(ctx, {
      platform_user_id: 'u-someone-else',
      nickname: '别人',
      profile_url: null,
      bio: '4S店销售顾问',
      ip_location: '浙江',
      follower_count: 1,
      note_count: 0,
      recent_notes: [],
    });
    const mismatch = await researchLead(ctx, lead.id);
    assert.equal(mismatch.status, 'skipped');
    assert.ok(mismatch.reason.startsWith('profile_mismatch'));
    assert.deepEqual(ctx.db.table('leads').require(lead.id).evidence, evidenceBefore);
    assert.equal(researchDecisions(ctx, lead.id).length, 3);
  });

  it('never reads the profile of a suppressed user', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-negative-001');
    seedSuppression(ctx, 'u-negative-001');
    let called = false;
    const sim = ctx.xhs;
    ctx.xhs = { ...scriptedProvider(ctx, new Error('unused')), capabilities: async (id?: string | null) => ((called = true), sim.capabilities(id)) };
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'skipped');
    assert.ok(res.reason.startsWith('lead_suppressed'));
    assert.equal(called, false);
  });

  it('skips undated recent notes instead of inventing their recency', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-undated-001');
    ctx.xhs = scriptedProvider(ctx, {
      platform_user_id: 'u-undated-001',
      nickname: '杭州小周',
      profile_url: 'https://www.xiaohongshu.com/user/profile/u-undated-001',
      bio: '杭州',
      ip_location: 'IP属地：浙江',
      follower_count: 10,
      note_count: 1,
      recent_notes: [
        {
          platform_post_id: 'note-undated-1',
          title: '杭州i3 35L白外红内有现车吗？这周想去看看',
          author: { platform_user_id: 'u-undated-001', nickname: '杭州小周' },
          like_count: 0,
          published_at: null,
        },
      ],
    });
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'researched');
    assert.equal(res.added_signals, 0);
    assert.equal(res.authenticity.score, 5, 'IP 属地 prefix is parsed');
    const notes = researchDecisions(ctx, lead.id)[0].output.notes as { outcome: string }[];
    assert.equal(notes[0].outcome, 'unknown_publish_time');
    assert.equal(ctx.db.table('lead_signals').count({ lead_id: lead.id, source_type: 'profile' }), 0);
  });
});

describe('lead-research · skill', () => {
  it('runs through the registry and validates input', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-hz-buyer-001');
    const registry = new SkillRegistry().register(skill);
    const out = await registry.invoke<LeadResearchResult>(ctx, 'lead-research', { lead_id: lead.id });
    assert.equal(out.lead_id, lead.id);
    assert.equal(out.status, 'researched');
    assert.equal(skill.agent, 'lead-research-agent');
    assert.throws(() => skill.input(null, 'lead-research'), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'lead-research', { lead_id: '' }), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'lead-research', { lead_id: 'lead_missing' }), /not found/);
  });
});
