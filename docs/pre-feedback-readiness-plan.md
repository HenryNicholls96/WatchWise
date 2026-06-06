# WatchWise — Pre-Feedback Readiness Plan

> Status: 2026-06-06. Purpose: get WatchWise in front of a second pair of eyes with (a) a usable, observable
> preview environment and (b) the ability to act on whatever they find. Companion to
> `docs/deployment-and-rollouts.md` (the deeper rollout strategy).

**TL;DR.** The engineering spine is done and green (228 tests, type-check + lint clean, CI gate, migrations,
distributed state, flags, release+flag telemetry, Sentry, `/api/health`). The only thing standing between us
and feedback is **operational, not code**: stand up a preview deploy with real catalog data, turn on the
infra creds (Sentry/Upstash), and confirm health. Realistically **2–3 focused days** of work inside a 1–2
week window, with buffer.

---

## 1. What is solid and ready

| Area | State | Evidence |
|---|---|---|
| CI gate | ✅ type-check · lint · test · build on push/PR to `main` | `.github/workflows/ci.yml` |
| DB migrations | ✅ Supabase CLI + ledger + DB-free safety checker in CI; expand→contract documented | `supabase/migrations/`, `scripts/check-migrations.mjs` |
| Distributed state | ✅ rate limiter + circuit breakers on `DistributedStore` (Upstash/InMemory), fail-open | `lib/utils/{distributed-store,rate-limit,circuit-breaker}.ts` |
| Feature flags | ✅ server-evaluated, env/store/% rollout, fail-open; `explanations_llm` kill switch | `lib/flags.ts` |
| Observability | ✅ one structured event/request, `journeyId` correlation, **flags + release stamped** | `lib/utils/observability.ts` |
| Error tracking | ✅ Sentry behind a fail-open facade, release-tied, wired to route catches + `instrumentation.ts` | `lib/utils/error-reporting.ts` |
| Health/readiness | ✅ `GET /api/health` (DB + store + release + flags; 503 when DB down) | `app/api/health/route.ts` |
| Recommendation pipeline | ✅ retrieve → filter → score → deferred explanations (Option B); 914-title catalog in prod | `lib/recommendations/*` |
| Test coverage | ✅ 228 tests (unit + route-level integration incl. authenticated journey) | `tests/` |

**Quality bar currently green:** `npm run type-check`, `npm run lint` (1 known benign warning), `npm test`
(228), `npm run db:check`.

---

## 2. Remaining gaps (ranked by reviewer impact)

| # | Gap | Impact if not addressed | Severity |
|---|---|---|---|
| 1 | **No live preview/staging URL** | Reviewer has nowhere to go. Hard blocker. | 🔴 Blocker |
| 2 | **Catalog data in a non-prod DB** | A fresh staging DB is empty → zero recommendations → the core experience doesn't work. Re-seeding hits Voyage/TMDb/OMDb (cost + ~45 min). | 🔴 Blocker (drives the env decision in §4) |
| 3 | **Infra creds not activated** (`SENTRY_DSN`, `UPSTASH_*`) | Sentry inert (no error visibility during the session); rate-limit/breakers per-instance. Both fail-open so the app *works*, but we'd be flying blind on a reviewer's errors. | 🟠 High |
| 4 | **Migration ledger not yet baselined via CLI** | `supabase_migrations.schema_migrations` is empty (001–008 were hand-applied). A `db:push` before baselining would try to re-run them. | 🟠 High (one-time, ~30 min) |
| 5 | **No authenticated end-to-end smoke test** | The DB write paths (taste seeds, session persistence) are only covered with fakes; a real regression could surface live during the session. | 🟡 Medium |
| 6 | **No reviewer "known issues / how to test" note** | Reviewers waste time reporting known gaps; feedback is noisier. | 🟡 Medium (cheap) |
| 7 | **UI polish not independently reviewed** | Out of our backend-only scope, but the *product* is the UX — flag it so the reviewer knows where to focus. | 🟡 Medium |
| 8 | **1 pre-existing lint warning** (`scripts/seed-content.ts`) | Cosmetic; blocks tightening CI to `--max-warnings 0` later. | 🟢 Low |

---

## 3. Recommended order of operations (1–2 weeks)

Sequenced so each step de-risks the next; **critical path ≈ 2–3 days**, rest is buffer/optional.

| Order | Action | Effort | Why first/now |
|---|---|---|---|
| 1 | **Baseline the migration ledger on prod** (`supabase link` + `npm run db:baseline` + `db:status`) | ~0.5 hr | Makes the DB CLI-managed before anything else touches it; unblocks safe `db:push`. |
| 2 | **Stand up the preview deploy** (Vercel preview → existing prod Supabase; see §4) | ~0.5 day | The blocker. Real catalog data, fastest path. |
| 3 | **Activate infra creds on the preview** (`SENTRY_DSN`, `SENTRY_ENVIRONMENT=preview`, `UPSTASH_*`, `DISTRIBUTED_STATE_BACKEND=auto`) | ~0.5 day | Turns on error visibility + true distributed state before review. |
| 4 | **Confirm via `/api/health`** (expect `status: ok`, `backend: redis`, `release: <sha>`) + trigger one synthetic error and see it in Sentry | ~0.5 hr | Proves the spine is actually wired in the live env. Go/no-go gate. |
| 5 | **Authenticated E2E smoke test** (onboarding → recommendation → feedback against a real test user) | ~0.5 day | Closes the last coverage gap; can run against the preview. |
| 6 | **Reviewer brief**: known-issues + "how to test in 60s" + where to focus | ~1–2 hr | Sharpens the feedback you get back. |
| 7 | **Quick wins** (§5): seed test accounts, verify kill switch, fix lint warning | ~1–2 hr | Smooths the session. |
| 8 | *(Optional, later)* **Fully isolated staging** with cloned catalog data | ~1–2 days | Only if you need reviewers to write freely without touching prod. Defer past round 1. |

---

## 4. Standing up the preview/staging environment (Vercel + Supabase)

### Decision: which database does the preview use?

| Option | Setup | Trade-off | Recommendation |
|---|---|---|---|
| **A. Preview deploy → existing prod Supabase** | Just env vars on a Vercel preview | Real 914-title catalog instantly; reviewers' (anonymous) onboarding writes land in prod tables (`user_profiles`, `user_taste_seeds`, `recommendation_sessions`) — low-risk and cleanable | ✅ **For round 1.** Fastest, real experience. |
| **B. Isolated Supabase (branch or new project)** | Apply migrations + **load catalog data** (the expensive part: dump/restore prod, or re-seed = Voyage/TMDb/OMDb cost + ~45 min) | Full write isolation | Defer to a later round once feedback cadence justifies it. |

> The catalog data is why B is a multi-day job, not a config change — don't underestimate it. Option A
> sidesteps it entirely for the first round.

### Runbook (Option A)

**One-time, with DB creds (gap #4):**
```bash
npx supabase link --project-ref <prod-project-ref>   # needs DB password
npm run db:baseline                                   # mark 001–008 applied WITHOUT re-running
npm run db:status                                     # confirm 001–008 show "applied"
```

**Vercel preview env vars** (Project → Settings → Environment Variables, scope = Preview):

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod values | catalog + auth |
| `SUPABASE_SERVICE_ROLE_KEY` | prod value | server-only (explanation cache, admin paths) |
| `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `TMDB_API_KEY`, `OMDB_API_KEY`, `STREAMING_API_KEY` | prod values | pipeline |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | new Upstash db | turns on distributed state |
| `DISTRIBUTED_STATE_BACKEND` | `auto` | redis once creds present |
| `SENTRY_DSN` | project DSN | enables error capture |
| `SENTRY_ENVIRONMENT` | `preview` | keeps preview errors separate from prod |
| `VERCEL_GIT_COMMIT_SHA` | (auto) | release stamping — Vercel sets it |

> Anonymous sign-ins must stay enabled in Supabase Auth (already on). `VERCEL_GIT_COMMIT_SHA` is provided by
> Vercel automatically — no action needed.

**Deploy:** push the branch (or promote a green preview). Confirm with §3 step 4.

---

## 5. Quick wins for smoother feedback sessions

- **Health check as the first thing you open.** `GET <preview-url>/api/health` → one-glance confirmation the
  preview is up, on the right `release`, with `backend: redis` and the expected `flags`. Use it before every
  session and after every redeploy.
- **Kill switch rehearsal.** Before the session, verify `explanations_llm` off → deterministic fallbacks
  (set `FLAG_EXPLANATIONS_LLM=off` or write `flag:explanations_llm={"enabled":false}` to Upstash). Now if
  Claude misbehaves mid-demo, you flip it without a redeploy.
- **A couple of seeded test accounts** with completed onboarding + varied taste, so a reviewer sees
  personalized results immediately instead of swiping through onboarding first.
- **A 5-line reviewer brief**: the 60-second happy path ("type a vibe → get 5–8 picks → open a card → read
  why"), what's intentionally rough (UI polish, mobile), and how to report (where + with what detail).
- **Fix the lint warning** (`scripts/seed-content.ts` unused `SkipReason`) so CI is spotless and can later be
  tightened to `--max-warnings 0`.
- **Instant Rollback ready.** Know the Vercel "Promote previous deployment" path (< 60s) in case a reviewer
  trips something bad.

---

## 6. Go / No-Go criteria

**GO when all of these are true:**

- [ ] `main` is green: `type-check`, `lint`, `test` (228), `db:check`, `build`.
- [ ] Migration ledger baselined (`db:status` shows 001–008 applied).
- [ ] Preview URL is reachable and `GET /api/health` returns **200 / `status: ok`**, with `release: <real sha>`
      and `checks.distributedStore.backend: redis` (proves distribution is on) — or a deliberate, documented
      `memory`.
- [ ] **Sentry is receiving events** from the preview (verified with one synthetic error; `release` + `environment: preview` correct).
- [ ] A reviewer can complete the **core happy path end-to-end** (onboarding → recommendations → open a card →
      explanation), verified by the authenticated smoke test or a manual run.
- [ ] `explanations_llm` kill switch verified to degrade gracefully.
- [ ] Reviewer brief (known issues + how-to-test) written.

**NO-GO if any of these:**

- [ ] `/api/health` returns 503 or `database.ok: false`.
- [ ] Recommendations return empty/error on the happy path (e.g. catalog not reachable from the preview).
- [ ] Sentry not capturing (we'd be blind to reviewer-triggered errors).
- [ ] Unsure how to roll back.

---

## Appendix — what is explicitly *out of scope* for this pass

- **Full isolated staging with cloned data** (Option B) — deferred to a later round.
- **UI/UX polish & mobile** — the product surface; needs its own review track (and is outside the
  backend-only mandate of recent work).
- **Performance/perf tracing, log drains, dashboards, SLO-based auto-rollback** — all P1/P2 in
  `docs/deployment-and-rollouts.md`; not required to *start* collecting feedback.
- **API versioning / mobile OTA** — only relevant once a non-web client is on the roadmap.
