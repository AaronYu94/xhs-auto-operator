# account-voice

## Responsibility
账号语言学习 / Account Voice: learn how **one** managed account actually writes, from the notes that account has
published, and keep that as an executable writing profile. One profile per account, keyed by `account_id` — two
accounts never share one, because the whole point is that each keeps its own voice.

A persona (`account_personas`) is what the store decided an account should sound like. A voice profile is what it
measurably sounds like: title length, sentence rhythm, paragraph shape, emoji density and which emoji, punctuation
habits, 你/您, first person, whether it quotes specs, how it names models, whether and how it closes with a call to
action, its recurring phrases and tags — plus a few of its own notes kept as few-shot material.

## Owning agent
`account-strategy-agent`.

## Inputs
- `learnAccountVoice(ctx, accountId, actor, {limit?, use_llm?})` — read the account's own notes and (re)build its profile.
- `refreshDealerVoices(ctx, dealerId, actor, {force?})` — every active account whose profile is missing or older than
  `VOICE_REFRESH_DAYS` (7).
- `collectAccountNotes(ctx, accountId, {limit?})` — the history read on its own (profile list → detail per note).
- `getAccountVoice(ctx, accountId)`, `listDealerVoices(ctx, dealerId)`, `needsVoiceRefresh(ctx, accountId)`.
- `voicePromptBlock(profile, {examples?, compact?})` — the block a prompt carries.
- `voicePronoun(profile)` / `applyVoicePronoun(text, profile)` — 你 or 您, as that account uses it.
- `voiceCopyCheck(ctx, accountId, text)` — is this new writing, or a reprint of an old note?
- Pure analysis in `analyze.ts`: `measure`, `vocabulary`, `deriveRules`, `pickExamples`, `checkCopy`, `usableSamples`.
- Skill `account-voice`: `{dealer_id?, account_id?, force?, limit?}`.

## Outputs
- `AccountVoiceProfile {account_id, dealer_id, sample_count, sample_note_ids, metrics, rules[{rule, basis}],
  vocabulary{openers, closers, cta_phrases, tags, phrases, emojis}, examples[{platform_note_id, title, excerpt, why}],
  avoid[], engine, analyzed_at, newest_sample_at}`.
- `VoiceLearnResult {account_id, account_name, status, reason, profile, fetched, used, skipped_own, engine}`.
- `CopyCheck {copied, similarity, platform_note_id, shared}`.

## Validation & guarantees
- **One profile per account** (`account_voice_profiles.account_id` is UNIQUE). Nothing merges profiles or falls back
  to another account's voice; an account without enough history simply has no profile and the writers work without one.
- **Only the account's own human-written history.** Notes this system published (`posts.platform_note_id`) are skipped,
  so a voice never learns from its own output and drift away from the person who built the account.
- **One odd post cannot move the voice.** Every measurement is a median or a share, a habit becomes a rule only with
  support in ≥ `RULE_SUPPORT` (40%) of notes, an "avoid" needs ≤ `AVOID_SUPPORT` (10%), and few-shot examples are the
  notes closest to the account's own median — never the most popular one.
- **Below `MIN_SAMPLES` (3) usable notes nothing is stored** and the result says why.
- **Every rule carries its basis** — the measurement it came from, or the verbatim passage that shows it.
- **LLM rules must quote evidence**: the quote has to appear verbatim in the account's own notes, the rule may not
  exceed 60 characters, and a rule containing a price or a spec number is dropped (numbers come from the vehicle
  library, never from a style profile). Without an LLM the profile is still complete from the measurements.
- **Style, not text**: `voiceCopyCheck` compares generated text with the very notes the voice was learned from and
  refuses it at ≥ `COPY_SIMILARITY` (0.55) similarity or ≥ `COPY_RUN_CHARS` (18) characters of verbatim overlap.
- Reading history needs a logged-in session; a logged-out account returns `REQUIRES_AUTH`, never a made-up profile.

## Runtime entry points
- Operator workflow `refresh_dealer_data` (daily) → step `learn_account_voice` → `refreshDealerVoices`.
- Console 账号 card → 「学习语言风格」/「重新学习」 → `POST /api/accounts/:id/voice`; the card shows the learned rules.
- Content (`post-generation`), outreach (`sales/outreach`) and conversation replies read the profile through
  `voicePromptBlock` / `applyVoicePronoun`, and check their output with `voiceCopyCheck`.
- Skill registry `account-voice`.

## Failure modes
- Unknown / removed account → `NotFoundError` / `PolicyError`.
- Provider without a login session, logged-out account, or no notes on the profile page → `{status, reason}`, nothing stored.
- Notes whose body cannot be read (no `xsec_token`, detail read refused) are skipped and counted, never guessed at.
- A failed LLM call leaves the measured profile in place; it is never a reason to store nothing.

## Tests
- `test/unit/account-voice/analyze.test.ts` — measurements, rule support thresholds, outlier resistance, example
  choice, and the copy check (same style ≠ copy, reprint = copy).
- `test/unit/account-voice/voice.test.ts` — history reading through a stub provider, profile storage, two accounts
  with different corpora getting different rules, re-learning after new notes, LLM evidence validation.
- `test/unit/account-voice/usage.test.ts` — the prompt block reaches content and outreach, the pronoun follows the
  account, and generated text that reprints an old note is refused.
