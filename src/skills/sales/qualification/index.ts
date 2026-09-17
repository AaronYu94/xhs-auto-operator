/**
 * Sales qualification (spec §13–14): decides whether a replying lead is a real sales opportunity.
 *
 * SALES_QUALIFIED when the desired model is known AND at least two of these are established:
 * budget · purchase timeframe within three months · location in the dealer's province · appointment intent ·
 * voluntarily provided contact · financing / leasing / trade-in specifics.
 * Signals come from the merged conversation slots of every conversation with the lead, the lead's merged public
 * intent (stated fields only for location), its stored contact and its active appointments.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import { formatCny } from '../../../core/text.ts';
import type { ConversationSlots, Lead } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { CITY_PROVINCE, modelDisplayName } from '../../../domain/automotive-lexicon.ts';
import { STAGE_INDEX, isSuppressed, isTerminalStage, refreshNextAction, transitionLead } from '../../operations/crm/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';

export const QUALIFICATION_AGENT = 'crm-agent';
const ACTOR = `agent:${QUALIFICATION_AGENT}`;

export const QUALIFICATION_CRITERIA = ['budget', 'timeframe', 'local', 'appointment', 'contact', 'payment'] as const;
export type QualificationCriterion = (typeof QUALIFICATION_CRITERIA)[number];
/** Criteria (besides a known model) that must be met. */
export const MIN_CRITERIA = 2;
const NEAR_TIMEFRAMES = new Set(['this_week', 'soon', 'this_month', 'within_3_months']);
const TIMEFRAME_LABELS: Record<string, string> = {
  this_week: '本周内',
  soon: '近期',
  this_month: '本月内',
  within_3_months: '三个月内',
  later: '较晚',
};

export interface QualificationResult {
  sales_qualified: boolean;
  reasons: string[];
  missing: string[];
}

export interface QualificationEvaluation extends QualificationResult {
  model_known: boolean;
  met: QualificationCriterion[];
  slots: ConversationSlots;
}

/** Slots of every conversation with the lead merged oldest → newest (later values win). */
export function mergedConversationSlots(ctx: AppContext, leadId: string): ConversationSlots {
  const merged: ConversationSlots = {};
  for (const c of ctx.db.table('conversations').findMany({ lead_id: leadId }, { orderBy: 'last_message_at ASC, created_at ASC' })) {
    for (const [k, val] of Object.entries(c.slots ?? {})) {
      if (val !== undefined && val !== null) (merged as Record<string, unknown>)[k] = val;
    }
  }
  return merged;
}

function provinceOf(place: string | undefined): string | undefined {
  if (!place) return undefined;
  const key = place.replace(/市$/u, '');
  return CITY_PROVINCE[key] ?? key.replace(/省$/u, '');
}

function budgetLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return min === max ? formatCny(min) : `${formatCny(min)}-${formatCny(max)}`;
  if (max !== undefined) return `${formatCny(max)}以内`;
  return `${formatCny(min ?? 0)}以上`;
}

/** Pure evaluation (no writes). */
export function evaluateQualification(ctx: AppContext, lead: Lead): QualificationEvaluation {
  const dealer = getDealer(ctx, lead.dealer_id);
  const slots = mergedConversationSlots(ctx, lead.id);
  const intent = lead.intent ?? {};
  const inferred = new Set(intent.inferred_fields ?? []);
  const reasons: string[] = [];
  const missing: string[] = [];
  const met: QualificationCriterion[] = [];

  const model = slots.model ?? (inferred.has('model') ? undefined : intent.model);
  const trim = slots.model ? slots.trim : (slots.trim ?? intent.trim);
  const modelKnown = Boolean(model);
  if (modelKnown) {
    const brand = intent.brand ?? dealer.brands[0] ?? '';
    const name = brand ? modelDisplayName(brand, model!, 'en') : model!;
    reasons.push(`意向车型明确（${trim ? `${name} ${trim}` : name}）`);
  } else {
    missing.push('意向车型未明确');
  }

  const budgetMin = slots.budget_min ?? intent.budget_min;
  const budgetMax = slots.budget_max ?? intent.budget_max;
  if (budgetMin !== undefined || budgetMax !== undefined) {
    met.push('budget');
    reasons.push(`预算明确（${budgetLabel(budgetMin, budgetMax)}）`);
  } else missing.push('预算未知');

  const timeframe = slots.purchase_timeframe ?? intent.purchase_timeframe;
  if (timeframe && NEAR_TIMEFRAMES.has(timeframe)) {
    met.push('timeframe');
    reasons.push(`购车时间近（${TIMEFRAME_LABELS[timeframe] ?? timeframe}）`);
  } else missing.push(timeframe ? `购车时间较晚（${TIMEFRAME_LABELS[timeframe] ?? timeframe}）` : '购车时间未知');

  const statedPlace = slots.location ?? intent.location ?? (inferred.has('province') ? undefined : intent.province);
  const province = provinceOf(statedPlace);
  if (province && province === dealer.province) {
    met.push('local');
    reasons.push(`本地/同省客户（${statedPlace}）`);
  } else missing.push(statedPlace ? `所在地不在本店服务省份（${statedPlace}）` : '所在地未确认');

  const activeAppointment = ctx.db.table('appointments').count({ lead_id: lead.id, status: ['proposed', 'confirmed', 'visited'] }) > 0;
  if (slots.appointment_intent === true || activeAppointment || intent.visit_intent === true) {
    met.push('appointment');
    reasons.push(activeAppointment ? '已有到店预约' : '有到店/试驾意向');
  } else missing.push('暂无到店意向');

  const contact = lead.contact ?? {};
  if (contact.phone || contact.wechat || slots.contact_phone || slots.contact_wechat) {
    met.push('contact');
    reasons.push('客户已主动留下联系方式');
  } else missing.push('未留联系方式');

  const payment: string[] = [];
  if (slots.financing === true || intent.financing_intent === true) payment.push('贷款');
  if (slots.leasing === true || intent.leasing_intent === true) payment.push('租赁');
  if (slots.trade_in === true || intent.trade_in_intent === true) payment.push(slots.trade_in_vehicle ? `置换（${slots.trade_in_vehicle}）` : '置换');
  if (payment.length > 0) {
    met.push('payment');
    reasons.push(`明确金融/置换需求（${payment.join('、')}）`);
  } else missing.push('付款/置换方式未明确');

  return { sales_qualified: modelKnown && met.length >= MIN_CRITERIA, reasons, missing, model_known: modelKnown, met, slots };
}

/**
 * Evaluate and, when qualified, move the lead forward to SALES_QUALIFIED (never backwards, never for do-not-contact or
 * closed leads). A `sales_qualification` decision is recorded when the stage changes.
 */
export function qualifyLead(ctx: AppContext, leadId: string): QualificationResult {
  if (typeof leadId !== 'string' || !leadId) throw new ValidationError('lead_id', 'expected non-empty string');
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  const ev = evaluateQualification(ctx, lead);
  const suppressed = lead.suppressed || isSuppressed(ctx, lead.platform_user_id, lead.platform) !== null;
  if (ev.sales_qualified && !suppressed && !isTerminalStage(lead.stage) && STAGE_INDEX[lead.stage] < STAGE_INDEX.SALES_QUALIFIED) {
    ctx.db.tx(() => {
      const res = transitionLead(ctx, lead.id, 'SALES_QUALIFIED', { reason: `销售合格：${ev.reasons.join('；')}`, actor: ACTOR });
      if (res.changed) {
        ctx.audit.decision({
          agent: QUALIFICATION_AGENT,
          skill: 'qualification',
          decision_type: 'sales_qualification',
          subject_type: 'lead',
          subject_id: lead.id,
          inputs: { stage: lead.stage, slots: ev.slots, intent: lead.intent, contact_provided: ev.met.includes('contact') },
          evidence: lead.evidence.slice(0, 10),
          output: { sales_qualified: true, criteria_met: ev.met, reasons: ev.reasons, missing: ev.missing },
          confidence: Math.min(0.95, 0.55 + 0.1 * ev.met.length),
          engine: 'rules',
        });
      }
      refreshNextAction(ctx, lead.id);
    });
  }
  return { sales_qualified: ev.sales_qualified, reasons: ev.reasons, missing: ev.missing };
}

export const skill = defineSkill<{ lead_id: string }, QualificationResult>({
  name: 'qualification',
  category: 'sales',
  agent: 'crm-agent',
  description: '根据车型、预算、购车时间、地域、到店意向、联系方式与金融/置换需求判断销售合格（SALES_QUALIFIED）',
  input: v.object({ lead_id: v.string({ min: 1 }) }),
  run: (ctx, input) => qualifyLead(ctx, input.lead_id),
});
