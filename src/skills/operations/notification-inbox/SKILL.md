# notification-inbox

## Responsibility
Mirror Xiaohongshu's own 消息中心 for every managed account: 评论和@ (`mentions`), 赞和收藏 (`likes`) and 新增关注
(`connections`). One row per notification in `xhs_notifications`, deduplicated on the platform's own notification id, with
everything a follow-up action needs (comment id for a reply or a like, note id + `xsec_token` to open the note, the
sender's `xsec_token` to open their profile). Comments that are buyer signals become leads through the normal pipeline.

This is the only inbound path the system has that the store did not have to go looking for: a comment on our own note is
the warmest signal there is, and before this it was visible only if the discovery search happened to find the same note.

## Owning agent
`lead-hunting-agent`.

## Inputs
- `syncAccountNotifications(ctx, accountId, {limit?, tabs?})` — read one account's notification centre (default all three
  tabs, 30 entries each, max 100).
- `syncDealerNotifications(ctx, dealerId, opts?)` — every active, non-removed account of the dealer, in fleet order.
- `unreadCounts(ctx, accountId)` — badge counts only (this call does not clear them).
- `listNotifications(ctx, dealerId, {tab?, kind?, status?, account_id?, limit?})`, `countNewNotifications(ctx, dealerId)`.
- `replyToNotification(ctx, id, text, actor)`, `likeNotification(ctx, id, actor, unlike?)`,
  `markNotificationHandled(ctx, id, actor)`, `ignoreNotification(ctx, id, actor)`, `promoteNotificationToLead(ctx, id, actor)`.
- Skill `notification-inbox`: `{dealer_id?, account_id?, limit?, tabs?}` (one of `dealer_id` / `account_id` is required).

## Outputs
- `SyncNotificationsResult {account_id, account_name, unread, tabs[], created, leads_created, detail}` — `tabs[]` reports
  each tab separately with its own `status` / `reason`, `fetched`, `created` and `filtered`.
- `XhsNotification` rows (`status` NEW → HANDLED / IGNORED) and the leads their comments created.
- `NotificationActionResult {notification, status, reason}` for reply / like.

## Validation & guarantees
- **Counts before lists.** Listing a tab clears its unread badge on Xiaohongshu (the same thing opening the page does),
  so the badge counts are read first, through `get_unread_count`, which clears nothing.
- **`filtered` is carried through, never swallowed:** entries the platform hid from us (deleted comment, note under
  review) are counted so the console can say the list is shorter than reality.
- **A like, a collect or a follower is never a lead by itself** — there is no text, so there is no purchase signal. A
  human can still promote one by hand (`promoteNotificationToLead`, source type `reply`, `data_mode: manual`).
- **Leads go through the same screen as discovery**: with an LLM configured only a screened `buyer` becomes a lead and a
  failed screen leaves the notification unscreened (never a rules fallback); without an LLM the rules decide.
  `upsertLeadFromSignal` then applies dedup, managed-account identity refusal, scoring and assignment as usual.
- **Replies and likes only on a confirmed outcome.** A notification becomes HANDLED with `reply_message_id` only when the
  provider confirmed the reply; an unconfirmed or failed outcome leaves it NEW with the reason and is never retried
  automatically. Automatic drafting of public replies stays in the `engagement` skill, which owns those guards.
- A tab that could not be read reports its provider status (`REQUIRES_AUTH` for a logged-out session) — never an empty list.
- Providers without a notification centre (simulation, none) say so; nothing is fabricated.

## Runtime entry points
- Operator workflow `reply_processing` (every 30 min) → step `sync_notifications` → `syncAccountNotifications` per active account.
- Console 对话 page, tabs 评论和@ / 赞和收藏 / 新增关注 → `listNotifications`, 「同步消息」 → `syncDealerNotifications`,
  per-row 回复 / 点赞 / 转为线索 / 处理完 / 忽略 → `replyToNotification`, `likeNotification`,
  `promoteNotificationToLead`, `markNotificationHandled`, `ignoreNotification`.
- JSON API `/api/notifications*`, `/api/accounts/:id/unread`.
- Skill registry `notification-inbox` for the Automotive Operator.

## Failure modes
- Unknown account / dealer / notification → `NotFoundError`; a removed account → `PolicyError` (`account_removed`).
- Reply on a notification without a comment → `PolicyError` (`not_repliable`); like → `not_likeable`; empty reply text →
  `ValidationError`.
- Provider without a notification centre (simulation, none) → the sync returns with `detail` naming the provider and no
  rows; the actions return `{status: 'UNAVAILABLE', reason}` instead of throwing.
- A logged-out session → each tab reports `REQUIRES_AUTH` with the instance's reason; the list is never shown as empty.
- `upsertLeadFromSignal` policy refusals (managed account identity, not a purchase signal, suppressed contact) are
  expected during a sync and skip that notification; anything else propagates.

## Tests
- `test/unit/notifications/notification-inbox.test.ts` — sync stores and deduplicates, buyer comments become leads,
  likes/follows do not, a failing tab is reported per tab, reply/like only on a confirmed provider outcome, promotion.
- `test/unit/providers/xhs-notifications.test.ts` — parsing real `list_notifications` / `get_unread_count` payloads,
  kind classification, epoch seconds vs milliseconds, and the provider's capability state.
- `test/unit/server/notifications-page.test.ts` — the 对话 page tabs and rows.
