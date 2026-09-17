import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FACT_QUESTION_KINDS,
  answerFact,
  verifyClaims,
  type FactQuestion,
} from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const MODELS = [undefined, 'i3', 'X3', '3系', '5系', 'i4', 'iX3', 'X1', 'Model Y'];
const TRIMS: Record<string, (string | undefined)[]> = {
  i3: [undefined, '35L', '40L'],
  X3: [undefined, '25L', '30L'],
  '3系': [undefined, '325Li', '330Li'],
};
const COLOURS: { exterior_color?: string; interior_color?: string }[] = [
  {},
  { exterior_color: '白', interior_color: '红' },
  { exterior_color: '黑色' },
  { exterior_color: '蓝' },
];

function questions(): FactQuestion[] {
  const out: FactQuestion[] = [];
  for (const kind of FACT_QUESTION_KINDS) {
    for (const model of MODELS) {
      for (const trim of (model && TRIMS[model]) || [undefined]) {
        const colourSets = kind === 'inventory' ? COLOURS : [{}];
        for (const colours of colourSets) out.push({ kind, model, trim, ...colours });
      }
    }
  }
  return out;
}

describe('dealer-brain: answerFact ⇄ verifyClaims round trip', () => {
  it('every answer for every kind, model, trim, colour and dealer verifies against its own facts', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    let checked = 0;
    let found = 0;
    for (const key of ['hz-bmw', 'sh-bmw']) {
      const dealerId = dealerIdByKey(s, key);
      for (const q of questions()) {
        const a = answerFact(ctx, dealerId, q);
        const label = `${key} ${JSON.stringify(q)} → ${a.text}`;
        assert.ok(a.text.length > 0, label);
        for (const f of a.facts) assert.ok(a.text.includes(f.claim), `${label}: claim ${f.claim}`);
        if (!a.found) assert.deepEqual(a.facts, [], `${label}: not-found answers carry no facts`);
        const check = verifyClaims(ctx, dealerId, a.text, a.facts);
        assert.equal(check.passed, true, `${label}\n${check.issues.join('\n')}`);
        assert.deepEqual(check.unverified_claims, [], label);
        assert.equal(check.verified.length, new Set(a.facts.map((f) => `${f.kind}:${f.id}:${f.claim}`)).size, label);
        checked++;
        if (a.found) found++;
      }
    }
    assert.ok(checked > 150, `checked ${checked}`);
    assert.ok(found > 60, `found ${found}`);
  });

  it('the same answer stops verifying once its offers expire (stale content is caught at review time)', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const a = answerFact(ctx, hz, { kind: 'offer', model: 'i3' });
    ctx.clock.set('2026-09-30T15:59:59.000Z'); // last second of 9月30日 in Shanghai
    assert.equal(verifyClaims(ctx, hz, a.text, a.facts).passed, true);
    ctx.clock.set('2026-09-30T16:00:00.000Z');
    const stale = verifyClaims(ctx, hz, a.text, a.facts);
    assert.equal(stale.passed, false);
    assert.ok(stale.unverified_claims.includes('9万'));
    assert.ok(stale.issues.some((i) => i.includes('有效期')));
  });
});
