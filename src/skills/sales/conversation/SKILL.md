# conversation

## Responsibility
Handles every direct-message reply from a (potential) customer and keeps the AI's part of the conversation short,
factual and compliant (spec §13):
- `processInboundMessage` stores the reply (conversation per lead × account), merges it into the lead as a `reply` signal
  (a user who writes to us first becomes a lead), moves the lead to REPLIED, extracts intents and slots
  (`conversation/nlu.ts`), and then:
  - refusal (`not_interested`) → global do-not-contact via CRM `suppressContact` (every account's pending outreach is
    cancelled, conversations closed, no reply drafted);
  - voluntarily provided phone / WeChat → `lead.contact` + CONTACT_ACQUIRED;
  - appointment intent → `upsertAppointment` (time resolved in the dealer timezone) + APPOINTMENT;
  - `qualifyLead` after every reply;
  - a reply draft built ONLY from Dealer Brain answers (`answerFact`: inventory, price + cash offers, finance, lease,
    trade-in, model highlights; store address/hours for visits — never the store phone), in the owning account's persona
    greeting, ≤ 300 characters, verified with `verifyClaims` and DM platform rules.
- Hands the conversation to a human (`needs_human`, `status handed_off`) when the reply reached a non-owner account,
  contains bargaining/complaints, the AI turn limit (`max_ai_conversation_turns`) is reached, the lead is closed, the user is
  on the do-not-contact list, or the draft fails verification.
- `approveReply` / `markReplySentManually`: the REVIEW_REQUIRED path. `pollInbox`: provider inbox polling.
- `ingestJuguangLeads`: 聚光「私信API对接」lead records → leads with voluntarily provided contact.
- `listConversations`: console list (needs-human first).

## Owning agent
`conversation-agent` (skill category `sales`).

## Inputs
- `processInboundMessage(ctx, {account_id, platform_user_id, username?, content, received_at?, provider_message_id?, source: 'provider'|'manual', actor?})`
- `approveReply(ctx, messageId, actor, editedText?)`, `markReplySentManually(ctx, messageId, actor)`, `pollInbox(ctx, accountId)`
- `ingestJuguangLeads(ctx, leads: JuguangLead[], {dealer_id, actor})`, `listConversations(ctx, {dealer_id, needs_human?, account_id?, limit?})`
- Skill input `{action: 'process_inbound'|'poll_inbox'|'approve_reply'|'mark_sent_manually', …fields of the chosen function}`.

## Outputs
- `InboundResult {conversation, message, lead, intents, slots, reply_draft, actions, duplicate}` — `actions` lists what
  happened (`lead_created`, `stage:REPLIED`, `contact_suppressed`, `contact_acquired`, `appointment_proposed`,
  `sales_qualified`, `handoff:<reason>`, `reply_drafted`, `reply_sent`, `duplicate_ignored`).
- `approveReply` / `markReplySentManually` → the updated `ConversationMessage`.
- `pollInbox` → `{status, processed, reason}`; `ingestJuguangLeads` → `{created, updated, suppressed_skipped, rejected}`.
- Rows: `conversations`, `conversation_messages` (inbound `received`; outbound `draft` → `sent` | `sent_manually` with `sent_by`),
  lead signals/stage/contact, appointments; `agent_decisions` of type `conversation_reply` for every processed inbound message
  (inputs, intent evidence with verbatim quotes, draft text, FactRefs, verification result, auto-send outcome);
  audit events `conversation.message_received`, `lead.contact_acquired`, `reply.approved`, `reply.sent`, `reply.send_failed`,
  `reply.sent_manually`, `inbox.polled`, `lead.juguang_imported`.

## Validation & guarantees
- Inputs validated (`v.*`); timestamps normalized to ISO; our own managed accounts can never be treated as customers.
- Idempotent: a repeated `provider_message_id` (also under a UNIQUE race) or the same manually entered text within two
  minutes returns `duplicate: true` without writing.
- A reply is `sent` ONLY with a provider-confirmed message id. Without an AVAILABLE `send_messages` capability the approved
  draft stays `draft` (with a `reply.approved` audit event, since `MESSAGE_STATUSES` has no approved state) and a human
  records `sent_manually`. Auto-send happens only under approval policy AUTO, an operable account and an AVAILABLE capability.
- Before approving or recording a send the blocking checks are re-run: do-not-contact, ownership (active assignment),
  blocking account health, `verifyClaims` against the draft's FactRefs (edits that add unverifiable numbers are refused) and
  DM platform rules (no phone / WeChat / QQ / links).
- Dealer facts come only from Dealer Brain rows; missing facts are stated honestly by `answerFact` text; landing prices are never
  computed; times containing digits are not echoed into replies (a human confirms them).
- DNC is global (`contact_suppressions` unique per platform user). 聚光 records of suppressed users are skipped.

## Runtime entry points
- Workflow `reply_processing` (every 30 min): `pollInbox` for each account — honest UNAVAILABLE on the live platform.
- Console 对话 page: manual entry of replies a salesperson received in the Xiaohongshu app (`source: 'manual'`),
  approve / edit / "我已在小红书发送".
- `POST /webhooks/juguang` → `parseJuguangLeadPush` → `ingestJuguangLeads`.

## Failure modes
- Unknown account / lead / message → `NotFoundError`; invalid input → `ValidationError`.
- Managed-account sender → `PolicyError('managed_account_identity')`.
- Approve/send of a non-draft → `PolicyError('reply_not_pending')`; suppressed → `contact_suppressed`; wrong account →
  `not_owner`; blocked account → `account_blocked`; failed checks → `reply_verification_failed` (nothing written).
- Provider send failure → message stays `draft`, `reply.send_failed` audit event with the provider reason.
- `pollInbox` reports provider failures as `{status, processed: 0, reason}`; per-message failures are listed in `reason`.

## Tests
`test/unit/conversation/conversation.test.ts`: verified price and inventory drafts (白外红内 35L from inventory rows), global
suppression cancelling another account's pending outreach, contact acquisition, appointment with Asia/Shanghai time,
duplicate provider ids, non-owner hand-off, turn limit, honest `pollInbox` with the unavailable provider and the scripted
simulation inbox, approve / edit refusal / manual send / provider send, AUTO policy send, 聚光 intake, listing and the skill wrapper.
