/** Page fragments shared by several console pages. */
import type { ConversationMessage, ConversationSlots } from '../../core/types.ts';
import { cny, esc, fmtTime, messageStatusPill } from '../render.ts';
import { xhsImageSrc } from '../api/media.ts';

/**
 * A person's or an account's real Xiaohongshu avatar, proxied. Without one it stays the first character of the name:
 * the console never borrows a stock face for someone whose picture it has not seen.
 */
export function avatarHtml(name: string, url: string | null | undefined, cls = ''): string {
  const src = xhsImageSrc(url);
  const letter = esc([...name.trim()][0] ?? '·');
  return `<span class="avatar${cls ? ` ${cls}` : ''}" aria-hidden="true">${letter}${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
}

export function threadHtml(messages: ConversationMessage[], tz: string): string {
  if (messages.length === 0) return '<p class="muted small">还没有对话记录。</p>';
  return `<div class="thread">${messages
    .map((m) => {
      const inbound = m.direction === 'inbound';
      const draft =
        m.status === 'draft'
          ? `<div class="stack" style="margin-top:8px" id="reply-${esc(m.id)}"><textarea name="text" id="reply-text-${esc(m.id)}">${esc(m.content)}</textarea>
  <div class="row"><button class="btn btn-ghost btn-sm" data-action="copy" data-target="#reply-text-${esc(m.id)}">复制</button>
  <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/messages/${esc(m.id)}/approve" data-form="#reply-${esc(m.id)}" data-success="回复已审核">审核回复</button>
  <button class="btn btn-primary btn-sm" data-action="call" data-url="/api/messages/${esc(m.id)}/mark-sent" data-confirm="确认已在小红书发出？再点一次" data-success="已登记人工发送">我已在小红书发送</button></div></div>`
          : '';
      const facts = m.fact_refs?.length ? `<div class="tiny muted">引用事实：${m.fact_refs.map((f) => esc(f.claim)).join('、')}</div>` : '';
      return `<div class="msg ${inbound ? 'msg-in' : 'msg-out'}">${m.status === 'draft' ? '<b class="small">AI 回复草稿（未发送）</b>' : esc(m.content)}${draft}${facts}<div class="msg-meta">${inbound ? '客户' : '我方'} · ${messageStatusPill(m.status)} · ${esc(fmtTime(m.created_at, tz))}${m.intents?.length ? ` · ${esc(m.intents.join('/'))}` : ''}${m.sent_by ? ` · ${esc(m.sent_by)}` : ''}</div></div>`;
    })
    .join('')}</div>`;
}

const TIMEFRAME: Record<string, string> = { this_week: '本周', soon: '近期', this_month: '本月内', within_3_months: '三个月内', later: '较晚/观望' };

export function slotsKv(s: ConversationSlots): string {
  const yes = (b: boolean | undefined) => (b === undefined ? '—' : b ? '是' : '否');
  const budget = s.budget_min !== undefined || s.budget_max !== undefined ? `${s.budget_min !== undefined ? cny(s.budget_min) : ''}${s.budget_min !== undefined && s.budget_max !== undefined ? ' – ' : ''}${s.budget_max !== undefined ? cny(s.budget_max) : ''}` : '—';
  const rows: [string, string][] = [
    ['车型', [s.model, s.trim].filter(Boolean).join(' ') || '—'],
    ['预算', budget],
    ['地区', s.location ?? '—'],
    ['购车时间', s.purchase_timeframe ? TIMEFRAME[s.purchase_timeframe] ?? s.purchase_timeframe : '—'],
    ['贷款', yes(s.financing)],
    ['租赁', yes(s.leasing)],
    ['置换', s.trade_in ? `是${s.trade_in_vehicle ? `（${s.trade_in_vehicle}）` : ''}` : yes(s.trade_in)],
    ['对比车型', s.competing_models?.join('、') || '—'],
    ['到店意向', s.appointment_intent ? `是${s.appointment_time_text ? ` · ${s.appointment_time_text}` : ''}` : '—'],
    ['预约时间', s.appointment_at ? fmtTime(s.appointment_at) : '—'],
    ['联系方式', [s.contact_phone && `电话 ${s.contact_phone}`, s.contact_wechat && `微信 ${s.contact_wechat}`].filter(Boolean).join(' · ') || '—'],
  ];
  return `<dl class="kv">${rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>`;
}

export const jsonDetails = (label: string, value: unknown, max = 4000): string =>
  `<details><summary class="small">${esc(label)}</summary><pre class="mono tiny" style="white-space:pre-wrap">${esc(JSON.stringify(value, null, 2).slice(0, max))}</pre></details>`;

export const resultBox = '<pre class="mono tiny card" data-result hidden style="white-space:pre-wrap;max-height:320px;overflow:auto"></pre>';
