import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntentDetection, XhsCapability } from '../../../src/core/types.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import type { ProviderFailure, XhsNoteSummary, XhsProvider, XhsUserProfile } from '../../../src/providers/xhs/types.ts';
import { buildReport } from '../../../src/providers/xhs/unavailable.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { detectIndustryAccount, researchLead } from '../../../src/skills/acquisition/lead-research/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedAssignment, seedOutreach, seedSuppression } from '../../helpers/fixtures.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ago = (ctx: TestContext, hours: number): string => new Date(ctx.clock.now().getTime() - hours * HOUR_MS).toISOString();

function setup() {
  const ctx = createTestContext();
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  const summary = loadDealerFixture(ctx);
  return { ctx, summary, hz: dealerIdByKey(summary, 'hz-bmw') };
}

const landing = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', trim: 'eDrive35L', location: '杭州', province: '浙江', price_intent: true, purchase_stage: 'active_shopping', confidence: 0.81 },
  evidence: [
    { code: 'specified_trim', label: '指定配置 eDrive35L', quote: '35L' },
    { code: 'landing_price', label: '询问落地价', quote: '落地多少' },
  ],
  transaction_questions: ['landing_price'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

function seedLead(ctx: TestContext, dealerId: string, userId: string) {
  return upsertLeadFromSignal(ctx, {
    dealer_id: dealerId,
    identity: { platform_user_id: userId, username: '看车用户' },
    signal: { source_type: 'import', content: '杭州i3 35L落地多少', signal_at: ago(ctx, 5), detection: landing() },
  }).lead;
}

function scripted(ctx: TestContext, profile: () => XhsUserProfile): XhsProvider {
  const fail = async (): Promise<ProviderFailure> => ({ ok: false, status: 'UNAVAILABLE', reason: 'not scripted' });
  return {
    name: 'scripted',
    mode: 'manual',
    capabilities: async (accountId?: string | null) =>
      buildReport('scripted', 'manual', accountId ?? null, ctx.clock, {
        read_public_profile: { status: 'AVAILABLE', reason: 'scripted profile' },
      } as Partial<Record<XhsCapability, { status: 'AVAILABLE'; reason: string }>>),
    searchNotes: fail,
    getNote: fail,
    getComments: fail,
    getUserProfile: async () => ({ ok: true, data: profile() }),
    publishNote: fail,
    getEngagement: fail,
    replyToComment: fail,
    listInboundMessages: fail,
    sendMessage: fail,
  };
}

const profileOf = (userId: string, patch: Partial<XhsUserProfile> = {}): XhsUserProfile => ({
  platform_user_id: userId,
  nickname: '杭州小周',
  profile_url: `https://www.xiaohongshu.com/user/profile/${userId}`,
  bio: '杭州打工人',
  ip_location: '浙江',
  follower_count: 10,
  note_count: 3,
  recent_notes: [],
  ...patch,
});

const note = (id: string, title: string, author: string, publishedAt: string | null): XhsNoteSummary => ({
  platform_post_id: id,
  title,
  author: { platform_user_id: author, nickname: null },
  like_count: 0,
  published_at: publishedAt,
});

function researchDecision(ctx: TestContext, leadId: string) {
  return ctx.audit.decisionsFor('lead', leadId).filter((d) => d.decision_type === 'lead_research').at(-1)!;
}

describe('lead-research hardening · industry detection on real profile text', () => {
  it('does not flag genuine buyers whose nickname or bio uses ambiguous trade words', () => {
    const buyers = [
      { nickname: '杭州房产经纪人小李', bio: '专注滨江二手房｜想换台电车' },
      { nickname: '保险销售顾问Amy', bio: '平安保险｜两个娃的妈' },
      { nickname: '医美销售顾问', bio: '杭州' },
      { nickname: '砍价小能手', bio: '4S店踩坑记录｜提车攻略' },
      { nickname: '等底价的阿强', bio: '求底价，准备国庆提车' },
      { nickname: '通勤党', bio: '卖了二手车准备换新能源' },
      { nickname: '网约车司机老林', bio: '每天晚上十点收车回家' },
      { nickname: '骑行爱好者', bio: '开了家自行车行｜周末骑行' },
    ];
    for (const buyer of buyers) {
      const res = detectIndustryAccount(buyer);
      assert.equal(res.industry, false, `${JSON.stringify(buyer)} → ${res.keywords.join(',')}`);
      assert.equal(res.evidence, null);
    }
  });

  it('still flags dealer, salesperson, used-car and broker accounts with a verbatim quote', () => {
    const cases: [{ nickname: string; bio: string | null }, string[], string][] = [
      [{ nickname: '宝马顾问小陈', bio: '杭州某宝马4S店销售顾问｜买车找我' }, ['4S店', '销售顾问', '买车找我'], '杭州某宝马4S店销售顾问'],
      [{ nickname: '二手车小刘', bio: '杭州｜每天分享' }, ['二手车'], '二手车小刘'],
      [{ nickname: '阿杰', bio: '４Ｓ店十年老兵，私信报价' }, ['4S店', '私信报价'], '４Ｓ店十年老兵'],
      [{ nickname: '老王', bio: '二手车经纪人｜高价收车' }, ['二手车', '收车', '经纪人'], '二手车经纪人'],
      [{ nickname: 'Kevin', bio: '奔驰销售顾问，欢迎咨询' }, ['销售顾问'], '奔驰销售顾问'],
      [{ nickname: '车商阿明', bio: null }, ['车商'], '车商阿明'],
      [{ nickname: '小王', bio: '宝马全网底价，私信我' }, ['底价'], '宝马全网底价'],
      [{ nickname: '汽车经纪人老周', bio: '' }, ['经纪人'], '汽车经纪人老周'],
      [{ nickname: '李姐聊宝马', bio: '杭州宝马中心销售顾问李娜｜X3/X1' }, ['销售顾问'], '杭州宝马中心销售顾问李娜'],
    ];
    for (const [profile, keywords, quote] of cases) {
      const res = detectIndustryAccount(profile);
      assert.equal(res.industry, true, JSON.stringify(profile));
      assert.deepEqual([...res.keywords].sort(), [...keywords].sort(), JSON.stringify(profile));
      assert.equal(res.evidence?.quote, quote, JSON.stringify(profile));
      assert.equal(res.evidence?.code, 'industry_account');
    }
  });

  it('keeps a real-estate agent who wants a car as a lead with default authenticity', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-agent-001');
    ctx.xhs = scripted(ctx, () => profileOf('u-agent-001', { nickname: '滨江房产经纪人小李', bio: '专注滨江二手房｜最近在看宝马i3', ip_location: '上海' }));
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.industry_account, false);
    assert.equal(res.authenticity.score, 4);
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'QUALIFIED');
  });
});

describe('lead-research hardening · closing an industry account', () => {
  it('releases the owning account and cancels undelivered outreach', async () => {
    const { ctx, summary, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-dealer-spam-001');
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    transitionLead(ctx, lead.id, 'ASSIGNED', { reason: '分配账号', actor: 'agent:fleet-controller' });
    const assignment = seedAssignment(ctx, { lead_id: lead.id, account_id: accountId });
    const outreach = seedOutreach(ctx, { lead_id: lead.id, account_id: accountId, assignment_id: assignment.id, status: 'READY_FOR_REVIEW', sent_at: null });

    const res = await researchLead(ctx, lead.id);
    assert.equal(res.industry_account, true);
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'LOST');
    assert.equal(ctx.db.table('lead_assignments').require(assignment.id).active, false);
    assert.equal(ctx.db.table('outreach').require(outreach.id).status, 'CANCELLED');
    const decision = researchDecision(ctx, lead.id);
    assert.equal(decision.output.assignment_released, true);
  });
});

describe('lead-research hardening · persistence guards', () => {
  it('persists nothing when the user is suppressed while the profile is being read', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-late-dnc-001');
    const before = ctx.db.table('leads').require(lead.id);
    const scores = ctx.db.table('lead_scores').count({ lead_id: lead.id });
    ctx.xhs = scripted(ctx, () => {
      seedSuppression(ctx, 'u-late-dnc-001');
      return profileOf('u-late-dnc-001', { bio: '杭州某宝马4S店销售顾问｜买车找我' });
    });
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.status, 'skipped');
    assert.ok(res.reason.startsWith('lead_suppressed'), res.reason);
    const after = ctx.db.table('leads').require(lead.id);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.stage, before.stage);
    assert.equal(ctx.db.table('lead_scores').count({ lead_id: lead.id }), scores);
  });

  it('only adds recent notes the user wrote within the last 90 days', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-notes-001');
    const now = ctx.clock.now().getTime();
    ctx.xhs = scripted(ctx, () =>
      profileOf('u-notes-001', {
        recent_notes: [
          note('note-other-001', '杭州325Li现在落地多少？', 'u-someone-else', new Date(now - DAY_MS).toISOString()),
          note('note-stale-001', '杭州X3 25L现在落地多少', 'u-notes-001', new Date(now - 200 * DAY_MS).toISOString()),
          note('note-fresh-001', '杭州i3 35L白外红内有现车吗？这周想去看看', 'u-notes-001', new Date(now - 2 * DAY_MS).toISOString()),
        ],
      }),
    );
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.added_signals, 1);
    const outcomes = (researchDecision(ctx, lead.id).output.notes as { platform_post_id: string; outcome: string }[]).map((n) => [n.platform_post_id, n.outcome]);
    assert.deepEqual(outcomes, [
      ['note-other-001', 'other_author'],
      ['note-stale-001', 'stale_note'],
      ['note-fresh-001', 'added'],
    ]);
    const profileSignals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id, source_type: 'profile' });
    assert.deepEqual(profileSignals.map((s) => s.content), ['杭州i3 35L白外红内有现车吗？这周想去看看']);
  });

  it('re-evaluates IP-based local verification on every research instead of keeping stale evidence', async () => {
    const { ctx, hz } = setup();
    const lead = seedLead(ctx, hz, 'u-moved-001');
    let ip = '浙江';
    ctx.xhs = scripted(ctx, () => profileOf('u-moved-001', { ip_location: ip }));
    assert.equal((await researchLead(ctx, lead.id)).authenticity.score, 5);
    assert.ok(ctx.db.table('leads').require(lead.id).evidence.some((e) => e.code === 'verified_local_user'));

    ip = '广东';
    const res = await researchLead(ctx, lead.id);
    assert.equal(res.authenticity.score, 4);
    assert.ok(!ctx.db.table('leads').require(lead.id).evidence.some((e) => e.code === 'verified_local_user'));
  });
});
