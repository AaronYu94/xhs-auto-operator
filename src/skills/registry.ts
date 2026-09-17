import type { AppContext } from '../app/context.ts';
import { AppError } from '../core/errors.ts';
import type { Validator } from '../core/validate.ts';

/** Specialized agents coordinated by the Automotive Operator (spec §3). */
export const AGENTS = [
  'automotive-operator',
  'research-agent',
  'account-strategy-agent',
  'content-agent',
  'content-review-agent',
  'publishing-agent',
  'lead-hunting-agent',
  'intent-detection-agent',
  'lead-research-agent',
  'lead-scoring-agent',
  'fleet-controller',
  'outreach-agent',
  'conversation-agent',
  'crm-agent',
  'analytics-agent',
  'optimization-agent',
] as const;
export type AgentName = (typeof AGENTS)[number];

export const SKILL_CATEGORIES = ['research', 'content', 'acquisition', 'sales', 'operations'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * A skill is a runtime capability with an explicit responsibility, validated input, typed output
 * and an owning agent. Skill modules export plain functions for direct typed use AND a
 * `skill` definition so the Operator can plan and invoke them by name.
 */
export interface SkillDefinition<I = unknown, O = unknown> {
  name: string;
  category: SkillCategory;
  agent: AgentName;
  description: string;
  input: Validator<I>;
  run(ctx: AppContext, input: I): Promise<O> | O;
  /** optional post-condition check; throw to fail the step */
  validateOutput?(output: O): void;
}

export function defineSkill<I, O>(def: SkillDefinition<I, O>): SkillDefinition<I, O> {
  return def;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition<unknown, unknown>>();

  register<I, O>(def: SkillDefinition<I, O>): this {
    if (this.skills.has(def.name)) throw new Error(`Skill already registered: ${def.name}`);
    this.skills.set(def.name, def as unknown as SkillDefinition<unknown, unknown>);
    return this;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  get(name: string): SkillDefinition<unknown, unknown> {
    const s = this.skills.get(name);
    if (!s) throw new AppError('unknown_skill', `Unknown skill: ${name}`, 404);
    return s;
  }

  list(): SkillDefinition<unknown, unknown>[] {
    return [...this.skills.values()];
  }

  async invoke<O = unknown>(ctx: AppContext, name: string, input: unknown): Promise<O> {
    const skill = this.get(name);
    const parsed = skill.input(input, name);
    const output = await skill.run(ctx, parsed);
    skill.validateOutput?.(output);
    return output as O;
  }
}
