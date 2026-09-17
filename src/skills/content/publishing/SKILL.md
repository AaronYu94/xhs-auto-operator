# publishing

## Responsibility
Moves approved notes onto Xiaohongshu through the owning account's provider session — or, when the system cannot
publish itself, hands them to a human with the exact reason — and collects engagement of published notes for
content → lead attribution and optimisation (spec §15 Scheduling/Publishing → Performance Collection, §16).

## Owning agent
`publishing-agent` (category `content`).

## Inputs
- `publishDuePosts(ctx, dealerId)` — posts in `APPROVED` / `SCHEDULED` with `scheduled_for ≤ now` (or null).
- `markPublishedManually(ctx, postId, {platform_note_id?, url?}, actor)`, `requeuePost(ctx, postId, actor)`,
  `setPostImages(ctx, postId, images, actor)`, `collectPerformance(ctx, dealerId)`,
  `recordPostMetrics(ctx, postId, metrics, actor)`, `parseNoteIdFromUrl(url)`.
- Skill input `{ dealer_id, action?: 'publish_due' | 'collect_performance' }`.

## Outputs
- `publishDuePosts` → `{published, ready_to_publish, skipped: {post_id, reason}[], changes_required, failed}`.
- `collectPerformance` → `{updated, status, reason, unreconciled, views_unavailable, failures}`.
- Audit events: `post.published`, `post.published_unreconciled`, `post.note_id_conflict`, `post.ready_to_publish`
  (with `reason`), `post.publish_retry_later`, `post.publish_failed`, `post.facts_invalid_at_publish`,
  `post.published_manually`, `post.note_reconciled`, `post.requeued`, `post.images_updated`,
  `posts.performance_collected`, `post.metrics_recorded`.

## Validation & guarantees
- `PUBLISHED` only on a provider `ok` result or an explicit human record. A confirmed publish without a note id
  (xiaohongshu-mcp returns none) keeps `platform_note_id = null` and records `post.published_unreconciled`; ids are
  never fabricated. A note id already used by another post is not stored (audit `post.note_id_conflict`).
- Per post, in order: daily publish limit of the account (`effectivePublishPolicy`) → account operability (blocking →
  skipped) → facts re-verified (an expired offer → `CHANGES_REQUIRED`) → policy `DISABLED` → `READY_TO_PUBLISH` →
  `publish_content` capability of that account not `AVAILABLE` → `READY_TO_PUBLISH` with status + reason → no images →
  `READY_TO_PUBLISH` (“小红书发布需要至少一张图片…”) → provider publish.
- Provider failures: `REQUIRES_REVIEW` (outcome unknown, e.g. timeout after dispatch) → `READY_TO_PUBLISH` with
  “发布结果未知，请到小红书账号核实，避免重复发布” and never retried automatically; `REQUIRES_AUTH` →
  `READY_TO_PUBLISH`; retryable `UNAVAILABLE` → stays scheduled (skipped); otherwise `FAILED`.
- `requeuePost` (READY_TO_PUBLISH / FAILED → SCHEDULED now) is a human decision, e.g. after confirming an unknown
  outcome did not publish or after re-login.
- `markPublishedManually` parses `https://www.xiaohongshu.com/explore/<id>`, `/discovery/item/<id>`, `/item/<id>`;
  short links must come with an explicit id; mismatched id/URL → `ValidationError`; also reconciles the id of a
  PUBLISHED post that had none.
- `collectPerformance` reads each account's notes with that account's session only when `read_engagement` is
  `AVAILABLE`; `views: null` keeps the stored views; unreconciled posts are reported, not guessed.

## Runtime entry points
- Operator workflows `content_publishing` (publish) and `performance_collection` (metrics); console buttons
  上传图片 / 已在小红书发布（登记链接） / 重新排期 / 登记数据; skill registry `publishing`.

## Failure modes
- `NotFoundError` unknown post/dealer/account; `PolicyError('invalid_post_status' | 'duplicate_note_id')`;
  `ValidationError` for bad URLs, ids, images, metrics or a missing actor.
- Provider exceptions are not caught here: providers return `ProviderResult` by contract.

## Tests
`node --test test/unit/content/publishing.test.ts` — no images → READY_TO_PUBLISH, capability unavailable →
READY_TO_PUBLISH, simulation publish with images → PUBLISHED with note id, null note id handled, unknown outcome not
retried + requeue, retryable failure stays scheduled, daily limit, future slots untouched, expired offer at publish,
manual publish URL parsing / conflicts / reconciliation, performance collection and manual metrics.
