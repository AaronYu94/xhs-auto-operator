# engagement

## Responsibility
Handles public comments on the dealer's OWN published notes (content operations engagement, never cold outreach):
answers buyer questions with verified Dealer Brain facts and an invitation to DM / use the 留资卡, thanks plain praise,
and ignores marketing accounts, refusals, managed accounts and do-not-contact users. Replies go out through the
provider only when it is genuinely possible and allowed; otherwise a human reviews and posts them.

## Owning agent
`publishing-agent` (category `content`).

## Inputs
- `draftEngagementReplies(ctx, dealerId)` — reads `posts` (PUBLISHED) → `public_posts` linked by `own_post_id` or
  `platform_post_id = posts.platform_note_id` → `public_comments` (collected by lead discovery / ingestion).
- `approveEngagementReply(ctx, replyId, actor, editedMessage?)`, `sendEngagementReply(ctx, replyId)`,
  `markEngagementReplySentManually(ctx, replyId, actor)`, `cancelEngagementReply(ctx, replyId, actor, reason)`.
- Skill input `{ dealer_id }`.

## Outputs
- `engagement_replies` rows (`message`, `fact_refs`, `guard_results`, `status`, `capability_status`,
  `provider_message_id`), one per comment (unique while not cancelled).
- Decision `engagement_reply` per draft (inputs: comment, kind; evidence: intent detection evidence; output: message,
  facts, guards, status). Audit events `engagement_reply.sent | send_failed | outcome_unknown | approved | blocked |
  sent_manually | cancelled`.

## Validation & guarantees
- Classification with the rules NLU on the comment in its note context: marketing → none; negative → none; pure praise
  / owner remark → short thanks (account-type voice); purchase signal → answer; anything else → none.
- Answers use only: inventory (`answerFact` claims such as `白外红内现车1台`), `<trim>指导价<price>`, active cash offer
  `优惠<amount>` + `截止日期`, finance `N期` / `0息` / `首付N成`, trade-in `补贴<amount>`, store business hours, or one
  vehicle highlight. Landing prices are never quoted. No phone / WeChat / links.
- Guards (§6 semantics): `negative_feedback` (global suppression, blocking), `account_health` (blocking when the account
  is disabled/RESTRICTED), `factual_verification` (blocking), `platform_rules` channel `comment` ≤ 280 chars (blocking),
  `duplicate` (≥ 90 % similar to this account's replies of the last 30 days → review), `approval_policy` (publish
  policy: DISABLED blocking, REVIEW_REQUIRED review, AUTO pass), `provider_capability` (`reply_comments` AVAILABLE and a
  note `xsec_token` → pass, else review).
- `SENT` only with a provider-confirmed id. An unknown outcome (`REQUIRES_REVIEW`) is recorded and the reply is never
  re-sent automatically (`sendEngagementReply` refuses); a human verifies and uses `markEngagementReplySentManually`.
- Comments older than 30 days, already handled comments and managed-account authors are skipped; drafting is idempotent.

## Runtime entry points
- Operator workflow `performance_collection` (after own-note comments are ingested), console engagement review queue,
  skill registry `engagement`.

## Failure modes
- `NotFoundError` for unknown rows; `PolicyError('invalid_reply_status' | 'reply_outcome_unknown' |
  'reply_capability_unavailable' | 'reply_blocked')`; `ValidationError` for missing actor / reason / empty message.
- Provider failures never throw: they leave the reply in review with the capability status and an audit event.

## Tests
`node --test test/unit/content/engagement.test.ts` — buyer question answered with verified inventory facts, praise
thanked, marketing / managed / suppressed skipped, idempotent re-run, AUTO + simulation reply capability → SENT,
edited reply with an invented price → BLOCKED, manual send path, cancellation, unknown outcome not re-sent.
