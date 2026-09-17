# content-review

## Responsibility
Quality gate between a drafted note and publishing (spec §15 "Fact Review → Duplicate Review → Approval"): verifies
every factual claim against Dealer Brain, catches near-duplicates across all accounts of the dealer (content
cannibalisation / mass templates), checks platform compliance, and applies the publish approval policy.

## Owning agent
`content-review-agent` (category `content`).

## Inputs
- `reviewPost(ctx, postId)` — post in `DRAFTED` or `IN_REVIEW`.
- `approvePost(ctx, postId, actor)` — post in `IN_REVIEW`; `rejectPost(ctx, postId, actor, reason)`.
- Skill input `{ post_id, action?: 'review'|'approve'|'reject' (default review), actor?, reason? }`.

## Outputs
- `posts.review: PostReview` = `fact_check {passed, issues, verified_claims}` (`verifyClaims` over title + cover + body
  with the post's `fact_refs`), `duplicate_check {passed, max_similarity, similar_post_id?}` (bigram similarity
  ≥ 0.85 against the dealer's non-planned, non-rejected posts of the last 60 days, all accounts), `compliance {passed,
  issues}` (platform rules channel `post` incl. contact leaks / dealer-prohibited phrases / 广告法 terms, persona taboo
  topics, format rules; plus non-blocking notes).
- Status: any blocking failure → `CHANGES_REQUIRED`; publish policy `AUTO` → `SCHEDULED` with `scheduled_for` =
  `slot_date` at the account type's local hour (official 12:00, salesperson 19:30, model_specialist 20:30,
  local_guide 18:00, customer_story 21:00; never in the past); `REVIEW_REQUIRED` → `IN_REVIEW`; `DISABLED` →
  `IN_REVIEW` with the note that nothing is published automatically.
- Decisions `content_fact_review` and `content_duplicate_review`; audit events `post.changes_required`,
  `post.in_review`, `post.auto_approved`, `post.approved`, `post.approval_refused`, `post.rejected`.

## Validation & guarantees
- Customer-story accounts and pillars always go to `IN_REVIEW` (owner authorisation must be confirmed by a human),
  even under `AUTO`.
- `approvePost` re-runs the full evaluation: an offer that expired since review, a new near-duplicate or a compliance
  problem moves the post to `CHANGES_REQUIRED` instead of approving it.
- `posts.approval_policy` is refreshed from the effective policy at review time.
- Approved posts use status `SCHEDULED` (approval + slot); `publishing` accepts `APPROVED` and `SCHEDULED`.

## Runtime entry points
- Operator workflow `content_publishing` (review freshly generated drafts), console review queue
  (`listReviewQueue`, 批准 / 驳回), skill registry `content-review`.

## Failure modes
- `NotFoundError` for unknown posts; `PolicyError('invalid_post_status')` for wrong statuses;
  `ValidationError` for a missing actor / reject reason.

## Tests
`node --test test/unit/content/content-review.test.ts` — clean draft → IN_REVIEW with decisions, injected fake price →
CHANGES_REQUIRED, cross-account near-duplicate → CHANGES_REQUIRED with `similar_post_id`, contact info → compliance
failure, AUTO → SCHEDULED at the account-type slot, customer story stays IN_REVIEW, approve / reject rules, approval
after offer expiry refused.
