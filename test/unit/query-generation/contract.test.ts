/**
 * ARCHITECTURE.md §8 B2 contract for automotive-query-generation: compile-time signature conformance (checked by
 * `npx tsc --noEmit`) plus runtime export, skill and SKILL.md checks for this directory.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../../../src/app/context.ts';
import { ValidationError } from '../../../src/core/errors.ts';
import type { GoalSpec, SearchQuery } from '../../../src/core/types.ts';
import * as B2 from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { AGENTS, SKILL_CATEGORIES } from '../../../src/skills/registry.ts';

type Conforms<Contract, Impl extends Contract> = Impl;

export type B2QueryGenerationContract = [
  Conforms<{ dealer_id: string; goal: GoalSpec; goal_id?: string | null }, B2.QueryPlanInput>,
  Conforms<(ctx: AppContext, input: { dealer_id: string; goal: GoalSpec; goal_id?: string | null }) => SearchQuery[], typeof B2.generateQueries>,
  Conforms<
    {
      query: SearchQuery;
      runs: number;
      posts_discovered: number;
      comments_scanned: number;
      users_evaluated: number;
      candidates: number;
      qualified: number;
      high_intent: number;
      lead_density: number;
      candidate_rate: number;
      appointments: number;
      won: number;
      conversion_rate: number;
      smoothed_density: number;
    },
    B2.QueryEffectiveness
  >,
  Conforms<(ctx: AppContext, dealerId: string, opts?: { from?: string; to?: string }) => B2.QueryEffectiveness[], typeof B2.getQueryEffectiveness>,
  Conforms<(ctx: AppContext, dealerId: string) => { reprioritized: number; derived: SearchQuery[]; retired: SearchQuery[] }, typeof B2.evolveQueries>,
  Conforms<(ctx: AppContext, dealerId: string, limit: number, goalId?: string | null) => SearchQuery[], typeof B2.selectQueriesToRun>,
];

const SKILL_DIR = fileURLToPath(new URL('../../../src/skills/acquisition/automotive-query-generation/', import.meta.url));
const SECTIONS = ['Responsibility', 'Owning agent', 'Inputs', 'Outputs', 'Validation & guarantees', 'Runtime entry points', 'Failure modes', 'Tests'];

describe('automotive-query-generation: §8 B2 contract', () => {
  it('exports the contract functions and a well-formed skill', () => {
    for (const name of ['generateQueries', 'getQueryEffectiveness', 'evolveQueries', 'selectQueriesToRun'] as const) {
      assert.equal(typeof B2[name], 'function', name);
    }
    assert.equal(B2.skill.name, 'automotive-query-generation');
    assert.equal(B2.skill.category, 'acquisition');
    assert.ok((SKILL_CATEGORIES as readonly string[]).includes(B2.skill.category));
    assert.ok((AGENTS as readonly string[]).includes(B2.skill.agent));
    assert.equal(B2.skill.agent, 'lead-hunting-agent');
    assert.ok(B2.skill.description.trim().length >= 10);
    assert.throws(() => B2.skill.input(null, B2.skill.name), ValidationError);
  });

  it('ships a complete SKILL.md', () => {
    const path = `${SKILL_DIR}SKILL.md`;
    assert.ok(existsSync(path));
    const md = readFileSync(path, 'utf8');
    assert.match(md, /^#\s+automotive-query-generation\s*$/m);
    for (const section of SECTIONS) {
      const parts = md.split(new RegExp(`^##\\s+${section.replace(/[&]/g, '\\&')}\\s*$`, 'm'));
      assert.equal(parts.length, 2, `exactly one "## ${section}" section`);
      assert.ok((parts[1].split(/^##\s+/m)[0] ?? '').trim().length > 0, `"## ${section}" is empty`);
    }
  });
});
