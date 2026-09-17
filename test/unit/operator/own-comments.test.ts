import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import { WorkflowEngine } from '../../../src/operator/workflow-engine.ts';
import { buildWorkflows } from '../../../src/operator/workflows.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import { createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedPublishedPost } from '../../helpers/fixtures.ts';

const OWN_NOTE = 'note-own-hz-i3-001';
const OWN_TOKEN = 'ABsimOwnHzI3001mZ7=';

function setup(withToken: boolean) {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const internalToPlatform = Object.fromEntries(Object.entries(summary.account_ids).map(([platform, internal]) => [internal, platform]));
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock, DEFAULT_SIMULATION_CORPUS_PATH, { account_platform_ids: internalToPlatform });
  const dealerId = dealerIdByKey(summary, 'hz-bmw');
  const accountId = accountIdByPlatformId(summary, 'xhs-hz-i3');
  const post = seedPublishedPost(ctx, { dealer_id: dealerId, account_id: accountId });
  ctx.db.table('posts').update(post.id, { platform_note_id: OWN_NOTE });
  if (withToken) {
    ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: OWN_NOTE,
      xsec_token: OWN_TOKEN,
      url: null,
      title: '宝马i3一周通勤体验',
      content: '',
      author_platform_user_id: 'xhs-hz-i3',
      author_nickname: 'i3电车研究所',
      author_profile_url: null,
      ip_location: null,
      tags: [],
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      published_at: null,
      own_post_id: post.id,
      first_search_run_id: null,
      fetched_at: ctx.clock.iso(),
      raw: {},
      data_mode: 'simulation',
    });
  }
  return { ctx, dealerId, post, engine: new WorkflowEngine(buildWorkflows()) };
}

describe('performance_collection → collect_own_comments', () => {
  it('reads comments on our own published note through the owning account and ingests them with provenance', async () => {
    const { ctx, dealerId, engine } = setup(true);
    const run = await engine.start(ctx, 'performance_collection', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    assert.notEqual(run.status, 'FAILED', run.error ?? '');
    const step = engine.getRun(ctx, run.id).steps.find((s) => s.step_key === 'collect_own_comments')!;
    assert.equal(step.status, 'SUCCEEDED', JSON.stringify(step.output));
    assert.equal(step.output.posts, 1);
    assert.ok((step.output.comments as number) > 0);
    assert.equal(step.output.data_mode, 'simulation');
    const publicPost = ctx.db.table('public_posts').findOne({ platform_post_id: OWN_NOTE })!;
    const comments = ctx.db.table('public_comments').findMany({ public_post_id: publicPost.id });
    assert.ok(comments.length > 0);
    assert.ok(comments.every((c) => c.data_mode === 'simulation'), 'simulation comments are labelled as simulation');
  });

  it('without a known xsec_token the step skips and says why (no guessed tokens)', async () => {
    const { ctx, dealerId, engine } = setup(false);
    const run = await engine.start(ctx, 'performance_collection', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    const step = engine.getRun(ctx, run.id).steps.find((s) => s.step_key === 'collect_own_comments')!;
    assert.equal(step.status, 'SKIPPED');
    assert.match(String(step.output.reason), /xsec_token/);
    assert.equal(ctx.db.table('public_comments').count(), 0);
  });
});
