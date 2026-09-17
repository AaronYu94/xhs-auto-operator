/**
 * Full vertical slice over the REAL runtime (file SQLite, migrations, skills, workflow engine, operator):
 * 1 dealer → ≥5 distinct accounts → goal → search → public posts/comments → classified, evidence-backed, deduplicated
 * leads → exactly one owning account per lead → personalized outreach (REVIEW_REQUIRED, manual send) → replies →
 * qualification → contact + appointment → visit → WON → DNC suppression → analytics → restart persistence.
 *
 * Live Xiaohongshu search needs a logged-in xiaohongshu-mcp session, so the acquisition corpus here is the labelled
 * simulation provider; a second case proves that the real (mcp) path with no reachable/logged-in session is reported
 * as blocked and fabricates nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createRuntime } from '../../src/app/bootstrap.ts';
import { loadConfig } from '../../src/app/config.ts';
import { isVerbatimQuote } from '../../src/core/evidence.ts';
import { LEAD_STAGES, type Lead, type LeadStage } from '../../src/core/types.ts';
import { getDashboard, getFunnel } from '../../src/skills/operations/analytics/index.ts';
import { recordConversion } from '../../src/skills/operations/crm/index.ts';
import { importDealerBrain, parseDealerBrainBundle, stableId } from '../../src/skills/operations/dealer-brain/index.ts';
import { confirmAppointment, markVisited } from '../../src/skills/sales/appointment/index.ts';
import { processInboundMessage } from '../../src/skills/sales/conversation/index.ts';
import { approveOutreach, listOutreachQueue, markOutreachSentManually } from '../../src/skills/sales/outreach/index.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/dealers/hangzhou-bmw-group.json', import.meta.url), 'utf8')) as unknown;
const HZ = stableId('dlr', 'zj-bmw-group', 'dealer:hz-bmw');
const ACTOR = '运营-集成测试';
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const stageIdx = (s: LeadStage) => LEAD_STAGES.indexOf(s);

describe('vertical slice: dealer goal → appointment → WON (real runtime)', { timeout: 300_000 }, () => {
  it('runs the whole acquisition + sales loop with honest states and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-slice-'));
    dirs.push(dir);
    const env = {
      APP_ENV: 'development',
      LOG_LEVEL: 'silent',
      DATABASE_PATH: join(dir, 'slice.db'),
      XHS_PROVIDER: 'simulation',
      XHS_SIM_REBASE_TO_NOW: 'true',
      SCHEDULER_ENABLED: 'false',
    };
    let rt = await createRuntime(loadConfig(env));
    let wonLeadId = '';
    let dncUserId = '';
    try {
      const { ctx } = rt;
      importDealerBrain(ctx, parseDealerBrainBundle(FIXTURE));
      rt.ensureSchedules();

      // ── 1 dealer, ≥5 distinct operational accounts ─────────────────────────
      const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: HZ, status: 'active' });
      assert.ok(accounts.length >= 5, `≥5 active accounts, got ${accounts.length}`);
      const personas = accounts.map((a) => ctx.db.table('account_personas').findOne({ account_id: a.id })!);
      assert.equal(new Set(personas.map((p) => p.tone)).size, accounts.length, 'every account has its own voice');
      assert.equal(new Set(accounts.map((a) => a.account_type)).size >= 4, true, 'mixed account types');
      assert.ok(new Set(personas.map((p) => p.focus_models.join(','))).size >= 4, 'different model focus');

      // ── goal → queries → search → public posts/comments → leads ────────────
      const { goal, run } = await rt.operator.submitGoal(ctx, { dealer_id: HZ, text: '这个月在杭州获取宝马i3线索', actor: ACTOR });
      const steps = ctx.db.table('workflow_steps').findMany({ run_id: run.id }, { orderBy: 'seq ASC' });
      assert.equal(run.status, 'SUCCEEDED', JSON.stringify(steps.map((s) => [s.step_key, s.status, s.error])));
      assert.ok(ctx.db.table('search_queries').count({ dealer_id: HZ, goal_id: goal.id }) > 0, 'goal generated search queries');
      const runs = ctx.db.table('search_runs').findMany({ dealer_id: HZ });
      assert.ok(runs.length > 0 && runs.every((r) => r.data_mode === 'simulation'), 'runs are labelled with their real provenance');
      assert.ok(runs.reduce((n, r) => n + r.posts_discovered, 0) > 0, 'posts scanned');
      assert.ok(runs.reduce((n, r) => n + r.comments_scanned, 0) > 0, 'comments scanned');

      // a second scheduled-style discovery pass runs further queries (the goal run executes the top 8 of its queries)
      const second = await rt.operator.runWorkflow(ctx, 'lead_discovery', HZ, ACTOR);
      assert.ok(['SUCCEEDED', 'PARTIAL'].includes(second.status), `lead_discovery ${second.status}: ${second.error}`);

      const groupLeads = ctx.db.table('leads').query('group_id = (SELECT group_id FROM dealers WHERE id = ?)', [HZ]);
      const qualified = groupLeads.filter((l) => stageIdx(l.stage) >= stageIdx('QUALIFIED') && l.stage !== 'LOST');
      assert.ok(qualified.length >= 3, `qualified leads, got ${qualified.length}`);
      assert.equal(groupLeads.filter((l) => l.platform_user_id === 'u-dealer-spam-001').length, 0, 'competitor salesperson never becomes a lead');
      // deduplication: one lead per identity, and signals from different notes merge into that single lead
      assert.equal(new Set(groupLeads.map((l) => l.platform_user_id)).size, groupLeads.length, 'one lead per platform user in the group');
      const mergedAcrossNotes = groupLeads.filter((l) => {
        const posts = new Set(ctx.db.table('lead_signals').findMany({ lead_id: l.id }).map((s) => s.public_post_id).filter(Boolean));
        return posts.size >= 2;
      });
      assert.ok(mergedAcrossNotes.length >= 1, 'a user seen under ≥2 different notes is ONE lead with merged signals');
      for (const l of groupLeads) {
        const buyerComments = ctx.db
          .table('public_comments')
          .findMany({ author_platform_user_id: l.platform_user_id })
          .filter((c) => ctx.db.table('lead_signals').findOne({ public_comment_id: c.id }));
        assert.equal(l.signal_count >= buyerComments.length, true, `${l.username}: every stored signal comment is merged into the lead`);
      }

      for (const lead of qualified) {
        assert.equal(lead.actor_type, 'BUYER', `${lead.username} classified BUYER before scoring`);
        assert.equal(lead.data_mode, 'simulation');
        const signals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id });
        const sources: string[] = [];
        for (const s of signals) {
          sources.push(s.content);
          if (s.public_comment_id) assert.equal(ctx.db.table('public_comments').require(s.public_comment_id).content, s.content, 'signal is the verbatim comment');
          if (s.public_post_id) {
            const post = ctx.db.table('public_posts').require(s.public_post_id);
            assert.match(post.url ?? '', /^https:\/\/www\.xiaohongshu\.com\/explore\//, 'exact source link preserved');
            sources.push(post.title, post.content, post.ip_location ?? '');
          }
          const c = s.public_comment_id ? ctx.db.table('public_comments').require(s.public_comment_id) : null;
          if (c?.ip_location) sources.push(c.ip_location);
        }
        for (const e of lead.evidence) if (e.quote) assert.ok(isVerbatimQuote(sources, e.quote), `evidence quote "${e.quote}" is verbatim from its source`);
      }

      // ── Fleet Controller: exactly one owner per qualified lead, spread across the fleet ──
      const owners = new Set<string>();
      for (const lead of qualified.filter((l) => !l.suppressed)) {
        const active = ctx.db.table('lead_assignments').findMany({ lead_id: lead.id, active: true });
        assert.equal(active.length, 1, `${lead.username} has exactly one active owning account`);
        owners.add(active[0].account_id);
      }
      assert.ok(owners.size >= 2, `leads routed to different accounts (${owners.size})`);

      // ── outreach: personalized, never SENT without provider confirmation ────
      assert.equal(ctx.db.table('outreach').count({ status: 'SENT' }), 0, 'no DM capability → nothing claims SENT');
      const queue = listOutreachQueue(ctx, { dealer_id: HZ }).filter((i) => i.outreach.status === 'READY_FOR_REVIEW');
      assert.ok(queue.length >= 2, `outreach ready for human review (${queue.length})`);
      const firstTouchLeads = new Set(ctx.db.table('outreach').findMany({ kind: 'first_touch' }).filter((o) => o.status !== 'CANCELLED' && o.status !== 'BLOCKED').map((o) => o.lead_id));
      assert.equal(firstTouchLeads.size, ctx.db.table('outreach').findMany({ kind: 'first_touch' }).filter((o) => o.status !== 'CANCELLED' && o.status !== 'BLOCKED').length, 'one live first touch per lead');

      const item = queue[0];
      const lead = ctx.db.table('leads').require(item.lead.id);
      const primary = ctx.db.table('lead_signals').findMany({ lead_id: lead.id });
      assert.ok(primary.some((s) => item.outreach.personalization.some((p) => p.quote && s.content.includes(p.quote))) || item.outreach.personalization.length > 0, 'message personalized from the real signal');
      assert.ok(item.copy_text && item.copy_text.length > 0 && item.copy_text.length <= 300, 'copy-ready message for the manual send');
      assert.equal(item.account.id, ctx.db.table('lead_assignments').findOne({ lead_id: lead.id, active: true })!.account_id, 'sender is the owning account');

      const approved = await approveOutreach(ctx, item.outreach.id, ACTOR);
      assert.notEqual(approved.status, 'SENT');
      const sent = markOutreachSentManually(ctx, item.outreach.id, ACTOR);
      assert.equal(sent.status, 'SENT_MANUALLY');
      assert.equal(sent.sent_by, ACTOR);
      assert.equal(ctx.db.table('leads').require(lead.id).stage, 'CONTACTED');

      // ── replies → fact-grounded draft → qualification → contact + appointment ──
      const reply1 = await processInboundMessage(ctx, {
        account_id: item.account.id,
        platform_user_id: lead.platform_user_id,
        username: lead.username,
        content: '现在i3优惠多少？有白色现车吗',
        source: 'manual',
      });
      // the reply names model + colour + inventory, so qualification may advance the lead beyond REPLIED immediately
      assert.ok(stageIdx(ctx.db.table('leads').require(lead.id).stage) >= stageIdx('REPLIED'));
      assert.ok(ctx.db.table('lead_stage_transitions').findMany({ lead_id: lead.id }).some((t) => t.to_stage === 'REPLIED'), 'REPLIED recorded');
      assert.ok(reply1.reply_draft, 'reply draft prepared');
      assert.ok(reply1.reply_draft!.fact_refs.length > 0, 'draft answers only with Dealer Brain facts');

      await processInboundMessage(ctx, {
        account_id: item.account.id,
        platform_user_id: lead.platform_user_id,
        username: lead.username,
        content: '我电话13800001234，明天下午3点去店里看看',
        source: 'manual',
      });
      const afterReplies = ctx.db.table('leads').require(lead.id);
      assert.equal(afterReplies.contact.phone, '13800001234', 'voluntarily provided contact stored');
      assert.ok(stageIdx(afterReplies.stage) >= stageIdx('APPOINTMENT'), `stage ${afterReplies.stage}`);
      const reached = new Set(ctx.db.table('lead_stage_transitions').findMany({ lead_id: lead.id }).map((t) => t.to_stage));
      for (const s of ['DISCOVERED', 'ASSIGNED', 'CONTACTED', 'REPLIED'] as const) assert.ok(reached.has(s), `transition to ${s} recorded`);
      assert.ok(reached.has('CONTACT_ACQUIRED') || reached.has('APPOINTMENT'));
      const salesQual = ctx.audit.decisionsFor('lead', lead.id).filter((d) => d.decision_type === 'sales_qualification');
      assert.ok(salesQual.some((d) => d.output.sales_qualified === true), 'sales qualification decided with reasons');

      const appt = ctx.db.table('appointments').findOne({ lead_id: lead.id });
      assert.ok(appt, 'appointment created');
      assert.equal(confirmAppointment(ctx, appt!.id, ACTOR).status, 'confirmed');
      markVisited(ctx, appt!.id, ACTOR);
      assert.equal(ctx.db.table('leads').require(lead.id).stage, 'VISITED');
      recordConversion(ctx, { lead_id: lead.id, outcome: 'won', amount: 353900, actor: ACTOR });
      assert.equal(ctx.db.table('leads').require(lead.id).stage, 'WON');
      wonLeadId = lead.id;

      // ── DNC: a rejection suppresses the person across every account ────────
      const other = queue.find((q) => q.lead.id !== lead.id)!;
      const otherLead: Lead = ctx.db.table('leads').require(other.lead.id);
      await approveOutreach(ctx, other.outreach.id, ACTOR);
      markOutreachSentManually(ctx, other.outreach.id, ACTOR);
      const refusal = await processInboundMessage(ctx, {
        account_id: other.account.id,
        platform_user_id: otherLead.platform_user_id,
        username: otherLead.username,
        content: '不需要，别再发了',
        source: 'manual',
      });
      assert.equal(refusal.reply_draft, null, 'no reply to a refusal');
      assert.ok(ctx.db.table('contact_suppressions').findOne({ platform_user_id: otherLead.platform_user_id }), 'global DNC row');
      assert.equal(ctx.db.table('leads').require(otherLead.id).suppressed, true);
      dncUserId = otherLead.platform_user_id;

      // ── analytics reflect the real rows ───────────────────────────────────
      const dash = getDashboard(ctx, { dealer_id: HZ });
      assert.ok(dash.discovery.posts_scanned > 0 && dash.discovery.comments_scanned > 0);
      assert.ok(dash.discovery.qualified >= 1);
      assert.ok(dash.outreach.contacted >= 2, `contacted ${dash.outreach.contacted}`);
      assert.ok(dash.outreach.replies >= 3, `replies ${dash.outreach.replies}`);
      assert.ok(dash.sales.appointments >= 1 && dash.sales.visits >= 1 && dash.sales.won >= 1);
      const funnel = getFunnel(ctx, { dealer_id: HZ });
      assert.ok((funnel.find((f) => f.stage === 'WON')?.count ?? 0) >= 1);
    } finally {
      await rt.close();
    }

    // ── restart on the same database file ───────────────────────────────────
    rt = await createRuntime(loadConfig(env));
    try {
      const { ctx } = rt;
      assert.equal(ctx.db.table('leads').require(wonLeadId).stage, 'WON', 'funnel state persisted');
      assert.ok(ctx.db.table('contact_suppressions').findOne({ platform_user_id: dncUserId }), 'DNC persisted');
      assert.equal(ctx.db.table('outreach').count({ status: 'SENT_MANUALLY' }), 2);
      assert.equal(ctx.db.table('conversions').count({ lead_id: wonLeadId, outcome: 'won' }), 1);
    } finally {
      await rt.close();
    }
  });

  it('real provider path without a reachable logged-in session is blocked and fabricates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-slice-live-'));
    dirs.push(dir);
    const liveUrl = process.env.XHS_LIVE_MCP_URL;
    const liveToken = process.env.XHS_LIVE_MCP_TOKEN_FILE ? readFileSync(process.env.XHS_LIVE_MCP_TOKEN_FILE, 'utf8').trim() : process.env.XHS_LIVE_MCP_TOKEN;
    const rt = await createRuntime(
      loadConfig({
        APP_ENV: 'development',
        LOG_LEVEL: 'silent',
        DATABASE_PATH: join(dir, 'live.db'),
        XHS_PROVIDER: 'mcp',
        // a real logged-out instance when provided, otherwise a closed local port (connection refused)
        XHS_MCP_RESEARCH_URL: liveUrl ?? 'http://127.0.0.1:9/mcp',
        ...(liveUrl && liveToken ? { XHS_MCP_RESEARCH_TOKEN: liveToken } : {}),
        XHS_MCP_TIMEOUT_MS: '150000',
        SCHEDULER_ENABLED: 'false',
      }),
    );
    try {
      const { ctx } = rt;
      importDealerBrain(ctx, parseDealerBrainBundle(FIXTURE));
      const caps = await ctx.xhs.capabilities(null);
      assert.equal(ctx.xhs.mode, 'live');
      assert.notEqual(caps.capabilities.search_public_content.status, 'AVAILABLE', 'no logged-in session → search is not AVAILABLE');
      const { run } = await rt.operator.submitGoal(ctx, { dealer_id: HZ, text: '这个月在杭州获取宝马i3线索', actor: ACTOR });
      const steps = ctx.db.table('workflow_steps').findMany({ run_id: run.id });
      const discovery = steps.find((s) => /discover/.test(s.step_key));
      assert.ok(discovery, 'discovery step exists');
      assert.equal(discovery!.status, 'SKIPPED', `discovery skipped honestly: ${JSON.stringify(discovery!.output)}`);
      assert.match(String(discovery!.output.reason ?? ''), /UNAVAILABLE|REQUIRES_AUTH|登录|不可用/);
      assert.equal(ctx.db.table('public_posts').count(), 0, 'no fabricated posts');
      assert.equal(ctx.db.table('leads').count(), 0, 'no fabricated leads');
      assert.equal(ctx.db.table('outreach').count(), 0, 'no outreach without real leads');
    } finally {
      await rt.close();
    }
  });
});
