import { newId } from '../core/ids.ts';
import type { AgentDecision, AuditEvent, DecisionType, Engine, Evidence } from '../core/types.ts';
import type { Db } from '../db/database.ts';

export interface DecisionInput {
  agent: string;
  skill: string;
  decision_type: DecisionType;
  subject_type: string;
  subject_id: string;
  inputs: Record<string, unknown>;
  evidence: Evidence[];
  output: Record<string, unknown>;
  confidence: number;
  engine: Engine;
  workflow_run_id?: string | null;
}

export interface EventInput {
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details?: Record<string, unknown>;
}

/**
 * Auditability (spec §22): every important AI decision records decision, agent,
 * inputs, evidence, output, confidence and timestamp; every state change records an AuditEvent.
 */
export class AuditLog {
  private readonly db: Db;
  readonly runId: string | null;

  constructor(db: Db, runId: string | null = null) {
    this.db = db;
    this.runId = runId;
  }

  /** Returns an AuditLog that stamps decisions with the given workflow run id. */
  withRun(runId: string | null): AuditLog {
    return new AuditLog(this.db, runId);
  }

  decision(d: DecisionInput): AgentDecision {
    const confidence = Math.max(0, Math.min(1, d.confidence));
    return this.db.table('agent_decisions').insert({
      id: newId('dec'),
      agent: d.agent,
      skill: d.skill,
      decision_type: d.decision_type,
      subject_type: d.subject_type,
      subject_id: d.subject_id,
      inputs: d.inputs,
      evidence: d.evidence,
      output: d.output,
      confidence,
      engine: d.engine,
      workflow_run_id: d.workflow_run_id ?? this.runId,
      created_at: this.db.clock.iso(),
    });
  }

  event(e: EventInput): AuditEvent {
    return this.db.table('audit_events').insert({
      id: newId('evt'),
      actor: e.actor,
      action: e.action,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      details: e.details ?? {},
      created_at: this.db.clock.iso(),
    });
  }

  decisionsFor(subjectType: string, subjectId: string): AgentDecision[] {
    return this.db
      .table('agent_decisions')
      .findMany({ subject_type: subjectType, subject_id: subjectId }, { orderBy: 'created_at ASC' });
  }

  eventsFor(entityType: string, entityId: string): AuditEvent[] {
    return this.db
      .table('audit_events')
      .findMany({ entity_type: entityType, entity_id: entityId }, { orderBy: 'created_at ASC' });
  }
}
