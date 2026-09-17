import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { normalizeText, textSimilarity } from '../../../src/core/text.ts';
import { CONTENT_PILLARS, type ContentPillar } from '../../../src/core/types.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { checkPlatformRules } from '../../../src/skills/operations/compliance/index.ts';
import { getProhibitedClaims, verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import { composeDraft, generatePost, skill } from '../../../src/skills/content/post-generation/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { insertPost, setupContent } from './helpers.ts';

const TYPES = ['xhs-hz-official', 'xhs-hz-sales-wang', 'xhs-hz-i3', 'xhs-hz-guide', 'xhs-hz-story'];

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  calls: LlmJsonRequest[] = [];
  private readonly respond: (req: LlmJsonRequest) => unknown;
  constructor(respond: (req: LlmJsonRequest) => unknown) {
    this.respond = respond;
  }
  status(): LlmStatus {
    return { provider: 'fake', status: 'AVAILABLE', model: 'fake-1', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    return { ok: true, data: this.respond(req) as T, model: 'fake-1' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

function assertPublishable(s: ReturnType<typeof setupContent>, post: { title: string; body: string; tags: string[]; cover_text: string; fact_refs: { claim: string }[] }, label: string) {
  const text = `${post.title}\n${post.cover_text}\n${post.body}`;
  const facts = verifyClaims(s.ctx, s.dealerId, text, post.fact_refs as never);
  assert.ok(facts.passed, `${label}: facts verify — ${facts.issues.join(' | ')}`);
  const rules = checkPlatformRules(text, { prohibited: getProhibitedClaims(s.ctx, s.dealerId), max_length: 1000, channel: 'post' });
  assert.ok(rules.passed, `${label}: platform rules — ${rules.issues.map((i) => i.message).join(' | ')}`);
  assert.ok([...post.title].length <= 20, `${label}: title ≤ 20 (${post.title})`);
  const len = [...post.body].length;
  assert.ok(len >= 300 && len <= 800, `${label}: body length ${len}`);
  assert.ok(post.tags.length >= 3 && post.tags.length <= 8, `${label}: tags ${post.tags.length}`);
  for (const r of post.fact_refs) assert.ok(normalizeText(text).includes(normalizeText(r.claim)), `${label}: claim "${r.claim}" verbatim in text`);
}

describe('post-generation', () => {
  it('each account type writes a distinct, fact-verified i3 price post in its own voice', async () => {
    const s = setupContent();
    const posts = [];
    for (const p of TYPES) {
      const planned = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc(p), pillar: 'price_offer', model: 'i3', angle: '当月政策解读' });
      const drafted = await generatePost(s.ctx, planned.id);
      assert.equal(drafted.status, 'DRAFTED');
      assert.equal(drafted.engine, 'rules');
      assert.ok(drafted.title.includes('i3'), `title has model: ${drafted.title}`);
      assertPublishable(s, drafted, p);
      const decisions = s.ctx.audit.decisionsFor('post', drafted.id).filter((d) => d.decision_type === 'content_generation');
      assert.equal(decisions.length, 1);
      assert.ok(decisions[0].evidence.length > 0, 'decision lists the dealer facts used');
      posts.push(drafted);
    }
    const official = posts[0];
    assert.ok(official.body.includes('我们'), 'official voice speaks as 我们');
    assert.ok(posts[1].body.includes('销售小王'), 'salesperson voice uses the persona name');
    assert.ok(posts[4].body.includes('授权'), 'customer story account requires owner authorisation');
    assert.ok(official.fact_refs.some((r) => r.kind === 'offer' && r.claim === '优惠9万'), 'September i3 offer used');
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        const sim = textSimilarity(posts[i].body, posts[j].body);
        assert.ok(sim < 0.85, `posts ${TYPES[i]} vs ${TYPES[j]} similarity ${sim}`);
      }
    }
    assert.equal(new Set(posts.map((p) => p.title)).size, posts.length, 'titles differ');
  });

  it('every pillar × model verifies and meets the format rules for the salesperson account', () => {
    const s = setupContent();
    for (const pillar of CONTENT_PILLARS as readonly ContentPillar[]) {
      for (const model of ['i3', 'X3', '3 Series', 'i4', null]) {
        const planned = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-sales-wang'), pillar, model });
        const draft = composeDraft(s.ctx, planned);
        assertPublishable(s, draft, `${pillar}/${model}`);
        assert.ok(draft.title.includes(draft.inputs.model_label), `${pillar}/${model}: title contains ${draft.inputs.model_label}`);
      }
    }
  });

  it('never uses stock words without stock rows and never uses expired offers', () => {
    const s = setupContent();
    const noStock = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-official'), pillar: 'inventory_showcase', model: 'i4', angle: '现车到店实拍' });
    const d = composeDraft(s.ctx, noStock);
    assert.doesNotMatch(`${d.title}\n${d.body}`, /现车|现货|有货|在途|库存/, 'i4 has no inventory at hz-bmw');
    const stocked = composeDraft(s.ctx, insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-official'), pillar: 'inventory_showcase', model: 'i3' }));
    assert.ok(stocked.fact_refs.some((r) => r.kind === 'inventory' && r.claim === '白外红内现车1台'), 'white/red i3 35L in stock');
    const price = composeDraft(s.ctx, insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-sales-wang'), pillar: 'price_offer', model: 'i3' }));
    assert.doesNotMatch(price.body, /12万|八月清库/, 'August clearance offer expired');
  });

  it('general dealer_event post uses the active campaign and the brand in the title', async () => {
    const s = setupContent();
    const post = await generatePost(s.ctx, insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-guide'), pillar: 'dealer_event', model: null }).id);
    assert.ok(post.title.includes('宝马'));
    assert.ok(post.fact_refs.some((r) => r.kind === 'knowledge'), 'campaign knowledge cited');
    assert.ok(!post.body.includes('0571'), 'store phone number never published');
    assertPublishable(s, post, 'dealer_event');
  });

  it('only generates from PLANNED / CHANGES_REQUIRED / DRAFTED and clears the previous review', async () => {
    const s = setupContent();
    const scheduled = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-i3'), pillar: 'model_review', model: 'i3', status: 'SCHEDULED' });
    await assert.rejects(() => generatePost(s.ctx, scheduled.id), PolicyError);
    const changes = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-i3'), pillar: 'model_review', model: 'i3', status: 'CHANGES_REQUIRED' });
    s.ctx.db.table('posts').update(changes.id, {
      review: { fact_check: { passed: false, issues: ['x'], verified_claims: [] }, duplicate_check: { passed: true, max_similarity: 0 }, compliance: { passed: true, issues: [] }, reviewed_at: s.ctx.clock.iso() },
    });
    const regenerated = await generatePost(s.ctx, changes.id);
    assert.equal(regenerated.status, 'DRAFTED');
    assert.equal(regenerated.review, null);
  });

  it('accepts a verified LLM rewrite and rejects one that invents a price', async () => {
    const s = setupContent();
    const valid = new FakeLlm((req) => {
      const body = /参考初稿[^\n]*\n标题：[^\n]*\n([\s\S]*)$/.exec(req.prompt)?.[1] ?? '';
      const title = /标题：([^\n]*)/.exec(req.prompt)?.[1] ?? '';
      return { title, body: body.replace('一次说清', '认真聊聊'), tags: ['宝马i3', '杭州宝马', '杭州买车'], cover_text: 'i3政策怎么选' };
    });
    s.ctx.llm = valid;
    const a = await generatePost(s.ctx, insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-sales-wang'), pillar: 'price_offer', model: 'i3' }).id);
    assert.equal(valid.calls.length, 1);
    assert.equal(a.engine, 'llm+rules');
    assert.ok(a.body.includes('认真聊聊'));
    assertPublishable(s, a, 'llm accepted');

    s.ctx.llm = new FakeLlm((req) => {
      const body = /参考初稿[^\n]*\n标题：[^\n]*\n([\s\S]*)$/.exec(req.prompt)?.[1] ?? '';
      return { title: 'i3超值优惠', body: body.replace('优惠9万', '优惠12万'), tags: ['宝马i3', '杭州宝马', '杭州买车'], cover_text: 'i3优惠' };
    });
    const b = await generatePost(s.ctx, insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-sales-wang'), pillar: 'price_offer', model: 'i3', angle: '另一个角度' }).id);
    assert.equal(b.engine, 'rules');
    assert.ok(!b.body.includes('12万'));
    const decision = s.ctx.audit.decisionsFor('post', b.id).find((d) => d.decision_type === 'content_generation');
    assert.equal((decision?.output.llm as { fallback_reason?: string }).fallback_reason, 'validation_failed');
  });

  it('is invocable through the skill registry', async () => {
    const s = setupContent();
    const registry = new SkillRegistry().register(skill);
    const planned = insertPost(s.ctx, { dealer_id: s.dealerId, account_id: s.acc('xhs-hz-i3'), pillar: 'model_review', model: 'i3' });
    const out = await registry.invoke<{ status: string }>(s.ctx, 'post-generation', { post_id: planned.id });
    assert.equal(out.status, 'DRAFTED');
  });
});
