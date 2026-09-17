import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomotiveIntent } from '../../../src/core/types.ts';
import { mergeIntents } from '../../../src/skills/acquisition/lead-deduplication/index.ts';

describe('mergeIntents', () => {
  it('returns an empty intent when both sides are empty', () => {
    assert.deepEqual(mergeIntents({}, {}), {});
  });

  it('keeps a detected intent unchanged when merged into an empty lead intent', () => {
    const intent: AutomotiveIntent = {
      brand: 'BMW',
      model: 'i3',
      trim: 'eDrive35L',
      location: '杭州',
      province: '浙江',
      price_intent: true,
      price_sensitivity: 'medium',
      purchase_stage: 'active_shopping',
      confidence: 0.81,
    };
    assert.deepEqual(mergeIntents({}, intent), intent);
    assert.deepEqual(mergeIntents(intent, {}), intent);
  });

  it('keeps the trim when a later signal only infers the same model (trim over none, stated beats inferred)', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3', trim: 'eDrive35L', purchase_stage: 'active_shopping' },
      { brand: 'BMW', model: 'i3', inventory_intent: true, purchase_stage: 'active_shopping', inferred_fields: ['brand', 'model'] },
    );
    assert.equal(merged.model, 'i3');
    assert.equal(merged.brand, 'BMW');
    assert.equal(merged.trim, 'eDrive35L');
    assert.equal(merged.inventory_intent, true);
    assert.equal(merged.inferred_fields, undefined, 'model/brand were stated by one of the signals');
  });

  it('marks a model inferred only when every signal inferred it', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3', inferred_fields: ['brand', 'model'] },
      { brand: 'BMW', model: 'i3', discount_intent: true, inferred_fields: ['brand', 'model'] },
    );
    assert.deepEqual(merged.inferred_fields, ['brand', 'model']);
  });

  it('prefers a stated model over a newer inferred different model', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3' },
      { brand: 'BMW', model: 'X3', inferred_fields: ['brand', 'model'] },
    );
    assert.equal(merged.model, 'i3');
    assert.equal(merged.inferred_fields, undefined);
  });

  it('prefers the more specific vehicle (with trim) over a newer stated model without trim', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3', trim: 'eDrive35L', color_intent: '白外红内' },
      { brand: 'BMW', model: 'X3' },
    );
    assert.equal(merged.model, 'i3');
    assert.equal(merged.trim, 'eDrive35L');
    assert.equal(merged.color_intent, '白外红内');
  });

  it('lets the newer model win on equal specificity and drops the other model trim/colour (consistent vehicle)', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3', color_intent: '白外红内' },
      { brand: 'BMW', model: 'X3', inventory_intent: true },
    );
    assert.equal(merged.model, 'X3');
    assert.equal(merged.color_intent, undefined);
    assert.equal(merged.trim, undefined);

    const toCompetitor = mergeIntents({ brand: 'BMW', model: 'i3', trim: 'eDrive35L' }, { brand: 'Tesla', model: 'Model 3', trim: '长续航' });
    assert.equal(toCompetitor.brand, 'Tesla');
    assert.equal(toCompetitor.model, 'Model 3');
    assert.equal(toCompetitor.trim, '长续航');
  });

  it('combines the same model written differently and keeps the newer trim when both specify one', () => {
    const merged = mergeIntents({ brand: 'BMW', model: '3 Series', trim: '325Li' }, { brand: 'BMW', model: '3 series', trim: '330Li' });
    assert.equal(merged.trim, '330Li');
    assert.equal(merged.model, '3 series');
  });

  it('lets the latest stated location win', () => {
    const merged = mergeIntents({ location: '杭州', province: '浙江' }, { location: '深圳', province: '广东' });
    assert.equal(merged.location, '深圳');
    assert.equal(merged.province, '广东');
  });

  it('never lets an IP-inferred province override a stated location', () => {
    const merged = mergeIntents(
      { location: '杭州', province: '浙江' },
      { province: '上海', inferred_fields: ['province'] },
    );
    assert.equal(merged.location, '杭州');
    assert.equal(merged.province, '浙江');
    assert.equal(merged.inferred_fields, undefined);

    const stated = mergeIntents({ province: '上海', inferred_fields: ['province'] }, { location: '杭州', province: '浙江' });
    assert.deepEqual([stated.location, stated.province, stated.inferred_fields], ['杭州', '浙江', undefined]);
  });

  it('uses the newer inferred location when no signal stated one', () => {
    const merged = mergeIntents({ province: '浙江', inferred_fields: ['province'] }, { province: '上海', inferred_fields: ['province'] });
    assert.equal(merged.province, '上海');
    assert.deepEqual(merged.inferred_fields, ['province']);
  });

  it('keeps a compatible city when a newer signal states only the province', () => {
    const compatible = mergeIntents({ location: '杭州', province: '浙江' }, { province: '浙江' });
    assert.deepEqual([compatible.location, compatible.province], ['杭州', '浙江']);

    const incompatible = mergeIntents({ location: '杭州', province: '浙江' }, { province: '江苏' });
    assert.equal(incompatible.location, undefined);
    assert.equal(incompatible.province, '江苏');

    const cityOnly = mergeIntents({}, { location: '宁波' });
    assert.deepEqual([cityOnly.location, cityOnly.province], ['宁波', '浙江']);
  });

  it('unions competing models without repeating the merged model', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'X3', competing_models: ['Q5L'] },
      { brand: 'BMW', model: 'X3', competing_models: ['GLC', 'q5l', 'X3'] },
    );
    assert.deepEqual(merged.competing_models, ['Q5L', 'GLC']);
  });

  it('ORs boolean intents (true wins, an explicit false is kept when nobody said true)', () => {
    const merged = mergeIntents(
      { inventory_intent: true, financing_intent: false },
      { financing_intent: true, trade_in_intent: false },
    );
    assert.equal(merged.inventory_intent, true);
    assert.equal(merged.financing_intent, true);
    assert.equal(merged.trade_in_intent, false);
    assert.equal(merged.leasing_intent, undefined);
  });

  it('keeps the most advanced purchase stage, the widest budget, the highest confidence and the latest timeframe', () => {
    const merged = mergeIntents(
      { purchase_stage: 'active_shopping', budget_min: 300_000, budget_max: 350_000, confidence: 0.9, purchase_timeframe: 'this_month' },
      { purchase_stage: 'research', budget_min: 250_000, budget_max: 320_000, confidence: 0.55, purchase_timeframe: 'this_week', price_sensitivity: 'high' },
    );
    assert.equal(merged.purchase_stage, 'active_shopping');
    assert.equal(merged.budget_min, 250_000);
    assert.equal(merged.budget_max, 350_000);
    assert.equal(merged.confidence, 0.9);
    assert.equal(merged.purchase_timeframe, 'this_week');
    assert.equal(merged.price_sensitivity, 'high');
  });

  it('lists only merged fields that are really inferred, in a stable order', () => {
    const merged = mergeIntents(
      { brand: 'BMW', model: 'i3', province: '浙江', inferred_fields: ['brand', 'model', 'province', 'trim'] },
      { discount_intent: true, purchase_stage: 'price_shopping' },
    );
    assert.deepEqual(merged.inferred_fields, ['brand', 'model', 'province']);
    for (const field of merged.inferred_fields ?? []) assert.notEqual((merged as Record<string, unknown>)[field], undefined);
  });

  it('does not mutate its inputs', () => {
    const base: AutomotiveIntent = { brand: 'BMW', model: 'i3', competing_models: ['Model 3'], inferred_fields: ['model'] };
    const next: AutomotiveIntent = { brand: 'BMW', model: 'i3', trim: 'eDrive35L', competing_models: ['Model Y'] };
    const baseCopy = structuredClone(base);
    const nextCopy = structuredClone(next);
    mergeIntents(base, next);
    assert.deepEqual(base, baseCopy);
    assert.deepEqual(next, nextCopy);
  });
});
