# WatchWise — Reviewer Readiness Checklist

> Go/No-Go before sending the preview to an external reviewer. Short by design — tick these, then send.
> Live URL: `https://watch-wise-eta.vercel.app` · Reviewer brief: `docs/reviewer-brief.md`

## Go / No-Go (all must be true)

- [ ] **Baseline green locally** — `npm run type-check`, `npm run lint` (only the known `SkipReason`
      warning), `npm test -- run` (229 passing), `npm run db:check`, `npm run build`.
- [ ] **Latest build is live** — `GET /api/health` `release` equals the latest `main` commit SHA.
- [ ] **Health is ok** — `status: ok`, `database.ok: true`, `distributedStore.ok: true`
      (`backend: memory` is expected), `flags.explanations_llm: true`.
- [ ] **Happy path works** — onboarding (swipe + 4 questions) → discovery query → 5–8 cards → open a card →
      "Why This One?" explanation appears. (Pipeline verified server-side via `/api/recommendations` +
      `/api/recommendations/explanations`; confirm the UI loop once in a browser.)
- [ ] **Latest UI is visible** — discovery hero reads **"No more scrolling"** / *"…we'll find you a gem"*;
      detail modal uses the updated layout (Why This One? · Similar to · where-to-watch).
- [ ] **Error tracking validated** — a controlled test error appears in Sentry with `environment: preview`,
      the correct release SHA, a real stack trace, and context tags. (Done via the verification probe;
      the serverless flush fix is shipped so real route errors will also land.)
- [ ] **Reviewer brief is accurate** — `docs/reviewer-brief.md` matches current behavior (deferred
      explanations, fail-open, `backend: memory`, kill-switch mechanics).

## Final quick wins (recommended, not blocking)

- [ ] **Rehearse the kill switch once** so a live toggle during a session is smooth:
      1. Vercel → project → Settings → Environment Variables → add `FLAG_EXPLANATIONS_LLM` = `false`
         (Production + Preview).
      2. Redeploy (~2 min). Verify `/api/health` shows `"explanations_llm": false` and that opening a card
         still gives a (deterministic) "why" line — nothing breaks.
      3. **Remove** the env var and redeploy to restore LLM explanations. Confirm `flags.explanations_llm`
         is `true` again.
- [ ] **Have one query ready to demo** (e.g. *"dark psychological thriller, not on Disney, in English"*) so
      the first impression is strong.
- [ ] **Know how to read a report** — ask reviewers to include the `/api/health` `release` + the query text.

## Known limitations to disclose (already in the reviewer brief)

- **No accounts** — sessions are anonymous; taste profile lives in the browser session. No test-account
  seeding needed; the reviewer just completes onboarding.
- **Shared prod database** — the preview currently reads/writes the production Supabase, so reviewer
  activity lands in prod data (low-risk, cleanable). Isolated staging is deferred.
- **`backend: memory`** — rate limits / circuit breakers are per-instance, not distributed. Fine for a
  single reviewer; Upstash makes them shared (and the kill switch instant) later.
- **UI/mobile polish** is intentionally out of scope for this round.

## Verdict

When the Go/No-Go block is fully checked, **send it.** The quick wins make the session smoother but none
block a first reviewer.
