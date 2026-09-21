/**
 * Live evaluation of the LLM lead screen against hand-labelled real comments (test/live/fixtures/lead-screen-labeled.json).
 * Skipped unless LIVE_LLM_EVAL=1 and an OpenRouter / Anthropic key is configured (it spends real tokens):
 *
 *   LIVE_LLM_EVAL=1 OPENROUTER_API_KEY=… LLM_PROVIDER=openrouter node --test test/live/lead-screen-live.test.ts
 *
 * Reports precision / recall of the 'buyer' verdict and the confusion matrix; fails below the thresholds.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createLlmProvider } from '../../src/providers/llm/index.ts';
import { screenCandidates, type ScreenItem } from '../../src/skills/acquisition/lead-discovery/llm-screen.ts';
import { createTestContext } from '../helpers/context.ts';

interface Row {
  label: 'buyer' | 'owner' | 'dealer' | 'advice' | 'chatter' | 'unsure';
  source_type: 'post' | 'comment';
  text: string;
  reply_to: string | null;
  post_title: string | null;
  post_content: string | null;
  ip_location: string | null;
}

const MIN_PRECISION = 0.85;
const MIN_RECALL = 0.8;
const enabled = process.env.LIVE_LLM_EVAL === '1';

describe('live: LLM lead screen on labelled real comments', { skip: enabled ? false : 'set LIVE_LLM_EVAL=1 (spends tokens)' }, () => {
  it(`buyer precision ≥ ${MIN_PRECISION} and recall ≥ ${MIN_RECALL}`, { timeout: 900_000 }, async () => {
    const { rows } = JSON.parse(readFileSync(new URL('./fixtures/lead-screen-labeled.json', import.meta.url), 'utf8')) as { rows: Row[] };
    const ctx = createTestContext();
    ctx.llm = createLlmProvider(process.env);
    assert.equal(ctx.llm.status().status, 'AVAILABLE', ctx.llm.status().reason);

    // one request per note, like discovery
    const byNote = new Map<string, number[]>();
    rows.forEach((r, i) => byNote.set(r.post_title ?? '', [...(byNote.get(r.post_title ?? '') ?? []), i]));
    const verdict = new Map<number, string>();
    let failures = 0;
    await Promise.all(
      [...byNote.values()].map(async (idx) => {
        const first = rows[idx[0]];
        const items: ScreenItem[] = idx.map((i) => ({
          id: `i${i}`,
          source_type: rows[i].source_type,
          text: rows[i].text,
          author_nickname: null,
          ip_location: rows[i].ip_location,
          reply_to: rows[i].reply_to,
        }));
        const out = await screenCandidates(ctx, { title: first.post_title ?? '', content: first.post_content ?? '' }, items, ['小鹏']);
        failures += out.unscreened;
        for (const [id, v] of out.verdicts) verdict.set(Number(id.slice(1)), v.role);
      }),
    );

    const labelled = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.label !== 'unsure');
    const confusion: Record<string, Record<string, number>> = {};
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const falsePositives: string[] = [];
    for (const { r, i } of labelled) {
      const got = verdict.get(i) ?? 'none';
      confusion[r.label] ??= {};
      confusion[r.label][got] = (confusion[r.label][got] ?? 0) + 1;
      if (got === 'buyer' && r.label === 'buyer') tp++;
      else if (got === 'buyer') {
        fp++;
        falsePositives.push(`[${r.label}] ${r.text.slice(0, 50)}`);
      } else if (r.label === 'buyer') fn++;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    console.log(JSON.stringify({ labelled: labelled.length, unscreened: failures, tp, fp, fn, precision, recall, confusion }, null, 2));
    if (falsePositives.length) console.log('false positives:\n' + falsePositives.join('\n'));
    assert.ok(precision >= MIN_PRECISION, `precision ${precision.toFixed(2)}`);
    assert.ok(recall >= MIN_RECALL, `recall ${recall.toFixed(2)}`);
  });
});
