# Easy Updates & Zero-Downtime Rollouts — Review & Plan

> Status: review (2026-06-06). Author: launch-readiness pass.
> Goal: push improvements to existing users with minimal/zero disturbance — the "one-click restart with the
> updated version" experience — across today's web deployment and future app-store/mobile channels.

This is a planning document, not an implemented system. It records the current state, the gaps, and a
prioritized plan. New Rolling Action List (RAL) items surfaced here are collected at the end.

---

## TL;DR

The **web** story is already strong almost for free: Vercel does immutable, atomic deploys with instant
rollback, so a new version is live on the *next request* with no user action — that *is* the "one-click
restart" experience for web. The real gaps are everything that makes a deploy *safe to trigger*:

1. **Database migrations are manual and decoupled from deploys** — the single biggest zero-downtime risk.
2. **No feature-flag / gradual-rollout layer** — every change is all-or-nothing for 100% of users.
3. **No release stamping or alerting in observability** — we can't quickly tell "did *this* deploy break it?"
4. **APIs are unversioned** — fine for a single web client, a hard blocker before any mobile client ships.

Recommended posture: stay lean and lean on what we already have (Vercel defaults, the new Upstash
`DistributedStore`, the existing structured-event observability). Add an expand/contract migration
discipline + a thin server-evaluated flag layer first; defer heavier tooling (LaunchDarkly, full canary
infra) until traffic justifies it.

---

## 1. Current deployment model & update mechanism

**What happens today when we push code:**
- Next.js 15/16 app hosted on Vercel (frontend + API routes as serverless functions, `runtime = 'nodejs'`).
  Supabase Cloud is the database/auth. No `vercel.json`, no `.github/` CI — deploys rely on Vercel defaults.
- Git push → Vercel builds an **immutable deployment** → on success the production alias is **atomically
  swapped** to the new build. There is no in-place mutation of a running server; the old deployment stays
  retained and can be re-aliased instantly (**Instant Rollback**).
- Each PR gets a **preview deployment** (isolated URL) automatically.
- Practical effect for users: the *next* request after the swap hits the new version. No restart, no
  maintenance window. This already delivers the "users get the update with zero action" property for web.

**Gaps / risks:**
- **No CI gate.** Type-check / lint / 195 tests are run locally, not enforced before a production deploy.
  A bad push can reach prod. (Vercel build only runs `next build`, which type-checks but does not run Vitest.)
- **Deploy ≠ migration.** Code and schema change on different clocks (see §2).
- **No promotion flow.** Production tracks a branch push directly rather than "promote a verified preview".

**Recommendations (P0/P1):**
- **[P0 — DONE]** GitHub Actions CI gate at `.github/workflows/ci.yml` (see "CI pipeline" below). Runs
  type-check → lint → test → build on every push and PR to `main`. *Still to do:* mark it a **required**
  status check in the GitHub branch-protection settings for `main` (a one-time repo setting, not code).
- **[P1]** Add a minimal `vercel.json` to pin the build/install commands and region, and adopt
  "promote a green preview to production" rather than push-to-prod, so what ships is exactly what was tested.
- **[P1]** Document the **Instant Rollback** runbook (Vercel dashboard → previous deployment → "Promote").
  Target: rollback in < 60s, no rebuild.

**CI pipeline (`.github/workflows/ci.yml`) — implemented.**
- Triggers: `push` and `pull_request` to `main`. One `verify` job on `ubuntu-latest`, Node 20, `npm ci`
  (lockfile-exact install), with `concurrency` cancelling superseded runs on the same ref.
- Steps, cheapest-first so failures surface fast: **type-check** (`tsc --noEmit`) → **lint** (`eslint`) →
  **test** (`vitest run`, 195 tests) → **build** (`next build`).
- A second, parallel **`migrations`** job runs `node scripts/check-migrations.mjs` (DB-free; Node only, no
  install) — see §2.
- The build step injects placeholder `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` so it's
  deterministic with no secrets — the gated pages only reference those during prerender and fail open
  without them; no real network calls happen at build time (verified by building with `.env.local` removed).
- Lint uses the default threshold (errors fail, warnings don't) so the gate is green on current `main`,
  which carries one known pre-existing warning (`scripts/seed-content.ts`). Tighten to `--max-warnings 0`
  once that's cleared.
- Verified the gate catches regressions: an injected type error fails type-check (TS2322, exit 2), an
  explicit `any` fails lint (`@typescript-eslint/no-explicit-any`, exit 1), and a failing assertion fails
  the test step (exit 1) — these are the exact classes hit during recent work (the distributed-state pass
  surfaced real TS2352/TS2554 errors and a lint warning that this gate would now block pre-merge).

---

## 2. Database migrations — safe schema changes without downtime

**Current state (the biggest gap):** migrations `001`–`008` live in `supabase/migrations/` but are applied
**by hand in the Supabase SQL editor**. There is no `supabase/config.toml`, no migration runner, no
`schema_migrations` ledger, and no link between "this code deploy" and "this schema version". `006` already
bit us: recreating `match_content` required a manual `drop function` first (return-type change, error
42P13) — a textbook *breaking* schema change.

**Core principle: Expand → Migrate → Contract (a.k.a. parallel change).** Never make a change that is
incompatible with the currently-running code. Every schema change is split so that, during the rollout
window, the DB is compatible with **both** the old and new code:

1. **Expand** — add new columns/tables/RPCs as *additive, nullable, defaulted*. Deploy this first; old code
   ignores them. (We already do the reader half: `parseContentRow` coerces missing fields to `null`, e.g.
   `blendedRating`, so pre-migration rows don't break. Keep that discipline.)
2. **Migrate/deploy** — ship code that writes/reads the new shape. Backfill data in a background job, not
   inline in the request path.
3. **Contract** — only after the new code is fully rolled out and stable, drop the old columns/RPCs in a
   *later* release. Never rename or drop in the same release that stops using them.

**Hard rules:**
- **Version breaking RPC signatures instead of mutating them.** `match_content`'s return shape changed in
  `006` via drop+recreate — during that window any in-flight call could fail. Next time add
  `match_content_v2(...)`, point new code at it, retire `match_content` a release later. Same for any
  function whose argument/return shape changes.
- **Additive columns must be nullable or have a default**, so inserts from old code still succeed.
- **No long table locks.** Add indexes `CONCURRENTLY`; avoid `ALTER TABLE` rewrites on hot tables during
  peak. (pgvector HNSW builds are expensive — schedule them.)
- **RLS-compatible.** New tables get RLS + policies (or service-role-only, like `explanation_cache` in 008)
  *in the same migration*, never after.

**Recommendations:**
- **[P0 — DONE]** Adopted the **Supabase CLI** as the canonical migration mechanism (`supabase` was already a
  devDependency). Added `supabase/config.toml` (via `supabase init`), npm wrappers (`db:new`, `db:push`,
  `db:status`, `db:baseline`, `db:check`), and a process guide at `supabase/migrations/README.md`. The
  ledger is `supabase_migrations.schema_migrations` on the remote, managed by the CLI. *Remaining one-time
  step* (needs DB creds, can't be done from a dev box without them): `supabase link` + `npm run db:baseline`
  to mark the hand-applied 001–008 as applied without re-running them, then `db:push` for everything new.
- **[P0 — DONE]** Documented and enforce **expand → deploy → contract**: expand migrations apply BEFORE the
  code deploy; contract migrations ship in a SUBSEQUENT release. The CI safety check (below) blocks an
  *unguarded* destructive statement so a contract step can't slip out accidentally; breaking RPCs must be
  versioned (`match_content_v2`) rather than dropped+recreated. (See README + `scripts/check-migrations.mjs`.)
- **[P1]** *(open upgrade)* Have CI apply pending migrations to a real **Supabase preview branch** per PR
  (database branching), so migrations are proven to apply from the current ledger — not just lint-checked.
  Gate it on `SUPABASE_ACCESS_TOKEN` + project-ref secrets so it's a no-op until configured.

---

## 3. Feature flags & gradual rollout — implemented (`lib/flags.ts`)

**[P1 — DONE]** A thin, server-evaluated flag layer built on the `DistributedStore`. Flags are evaluated on
the server and **never serialized to the client** (no UI flicker, no leak), and are **fail-open** — any
error degrades to the flag's declared default, never a thrown error or a blocked user.

**Model.** A flag is registered in `FLAG_REGISTRY` as `{ description, defaultEnabled, rollout? }`.
Resolution precedence (highest first):

1. **Env override** `FLAG_<NAME>` (`on`/`off`/`true`/`false`/`1`/`0`/…) — an emergency **kill switch** that
   short-circuits before any I/O. e.g. `FLAG_EXPLANATIONS_LLM=off`.
2. **Store override** at key `flag:<name>` = `{ enabled?, rollout? }` — flip or ramp at runtime **without a
   redeploy**. Reads are amortized by a ~30s in-process TTL cache, so evaluation is cheap on the hot path.
3. **Registry default** (`defaultEnabled` / `rollout`).

**Deterministic % rollout:** when `rollout` (0–100) is set and the flag is enabled,
`bucketFor(name, subject) = sha256(`${name}:${subject}`).uint32 % 100 < rollout`. Same `subject` (a userId,
or `ip:<ip>` for anon) → same bucket → consistent experience; ramp by raising `rollout` 1→10→50→100. A
partial rollout with no subject resolves to `false` (can't bucket) — boolean flags ignore the subject.

**API (server-only; usable in API routes AND the recommendation engine):**
```ts
import { isFeatureEnabled, listFlags } from '@/lib/flags'
if (await isFeatureEnabled('explanations_llm', userId ?? `ip:${ip}`)) { /* feature on */ }
```

**Adding a flag:** add one entry to `FLAG_REGISTRY` in `lib/flags.ts` (the `FlagName` type updates
automatically), then call `isFeatureEnabled('<name>', subject?)` from any server code. `listFlags()` returns
all flags + their env-var names for tooling. Kill it instantly with `FLAG_<NAME>=off`; ramp it with a
`flag:<name>` store write.

**Wired today:** `explanations_llm` (default ON) gates the paid Claude call in
`POST /api/recommendations/explanations` — off → deterministic fallbacks only (cost/incident kill switch),
no user-facing failure.

**Flag observability — done.** Both structured events carry a `flags` field — the resolved set for the
request's caller (`{ explanations_llm: true, … }`), produced by `evaluateAllFlags(subject)` (one cheap,
cache-backed, fail-open call per request). `recommendation_request` and `explanation_request` stamp it on
the success path, so you can grep a request and see exactly which flags/kill-switches were active, and slice
any metric by variant. The field is omitted on pre-pipeline rejections (rate-limit / bad-request).

**Trade-offs / upgrade path:** the home-grown layer is ~1 file, zero new vendor, reuses Upstash, supports
instant flips — but has no admin UI, audit log, or targeting rules. If we outgrow it, swap the resolver's
store read for **Vercel Flags SDK + Edge Config** (edge-fast, a UI) or **LaunchDarkly/Statsig** (full
targeting/experiments) behind the same `isFeatureEnabled` interface, without touching call sites.

---

## 4. Backward-compatibility requirements

The rule: **a new deploy must tolerate data and requests produced by the old version, and vice versa, for
the duration of any rollout/skew window.** Specific contracts:

**Recommendation engine & scoring**
- `scoreBreakdown` / `AppliedConstraints` are response *contracts*. Treat them as append-only: add fields,
  never repurpose or remove without a version bump. The client already tolerates extra fields.
- The deferred-explanation endpoint re-runs the pipeline server-side and takes **only the search intent** (no
  client-supplied scores — "Option B"). This is a backward-compat *asset*: there is no client-carried ranking
  state that can go stale across a deploy. Preserve this property.

**Explanation format & cache**
- Cache key = `content_id:query_hash[:taste_signature]` in `explanation_cache` (24h TTL). **If the prompt or
  output format changes, prepend a format version to the key** (e.g. `e2:content_id:...`). This instantly
  partitions old vs new cached text — no migration, and stale entries age out via TTL. Cheap and safe.

**Stored user data (taste profiles, swipes, preferences)**
- `user_taste_seeds` (sentiment enum `loved|liked|disliked` + content) and `user_profiles.preferences`
  (jsonb) are long-lived user data — they must survive every deploy. Readers already fail-open
  (`profileToDefaults` tolerates partial/odd data; malformed taste seeds are skipped, not fatal).
- **[P1]** Stamp `preferences.schemaVersion` so future readers can migrate-on-read. Never require a
  destructive backfill of user data to ship a feature.
- The sentiment enum and "swipes are positive/negative signals, never an exclusion list" semantics are a
  stable contract — changing them is a breaking change requiring expand/contract on the data.

**Distributed store (new)**
- Breaker state JSON shape and rate-limit/flag keys are shared across instances *and across versions during a
  rollout*. **Namespace keys with a schema version** (e.g. `cb:v1:claude`, `rl:v1:...`) so a state-shape
  change during a deploy doesn't have two code versions fighting over one key. A bumped prefix = a clean
  cutover (old keys TTL out). Today's keys are unversioned — adding the prefix is a small, safe change.

---

## 5. In-flight requests during deploys

- Vercel never mutates a running function. On the alias swap, **new requests route to new functions; old
  functions finish their in-flight work and drain.** There is no forced kill of an active request.
- Keep handlers **short and idempotent** (they already are; the heaviest path is ~600–900ms for the deferred
  grid). Long work (backfills, embedding, rating blend) runs in scripts/jobs, not request handlers — keep it
  that way so a deploy never interrupts meaningful in-request work.
- **Version skew is the real risk, and it's handled by §2's expand/contract**: because the DB stays
  compatible with both code versions during the overlap, an old-code request mid-deploy can't hit a schema
  that only the new code understands (or vice versa).
- The two-step journey (main grid + deferred explanations) can have the two requests served by *different*
  versions during a swap. Because the explanation endpoint is server-authoritative and re-derives everything
  from the query, this is safe — the result set is deterministic for `(query, taste, catalog)`. Preserve this.

---

## 6. Observability during rollouts

**Current state:** one structured event per request (`recommendation_request`, `explanation_request`),
`circuit_breaker` transition events, all fail-open to the console (→ Vercel logs), correlated by `journeyId`.
Good foundation. Missing: a **release marker**, a **flag/variant marker**, **error/stack capture**, and
**alerting/thresholds**.

**Recommendations:**
- **[P0 — DONE]** Every structured event is stamped with `release` AND the resolved `flags` set, so any
  metric can be sliced "old build vs new build" / "flag on vs off" — what makes a canary or % rollout
  *measurable*, and lets you spot a deploy×flag regression. `release` comes from `getCurrentRelease()` in
  `lib/utils/observability.ts` (memoized; `VERCEL_GIT_COMMIT_SHA` → `RELEASE` → `GIT_COMMIT_SHA` → `'unknown'`,
  40-char SHA shortened to 7) and is baked into each route's base `emit()`, so it appears on **every** terminal
  path (success, rate-limit, bad-request, error). `flags` is stamped on the success path (see §3).
- **[P0 — DONE]** **Error tracking via Sentry**, behind a fail-open facade. See "Error tracking" below.
- **[P1]** Define **golden signals + rollback thresholds**: request error rate, p95 `totalMs`, `breakerOpen`
  rate, `zeroResult` rate, explanation `fallbackCount`/`deadlineHit` rate. A spike in any during/after a
  deploy → Instant Rollback. Wire these into a dashboard (Vercel Analytics + a log drain to e.g. Axiom/
  Datadog/Grafana).
- **[P1]** Set up a **log drain** off the console (the observability module was explicitly designed for the
  sink to change without touching call sites — collect on that).

### Error tracking (`lib/utils/error-reporting.ts`) — implemented

A thin, **fail-open** facade over Sentry. Goal: visibility into *unexpected* errors before launch — not a
full observability platform — so it's errors-only (no tracing/perf), server-side only, and can never throw
or block a request.

- **Lazy + optional.** Sentry is loaded via dynamic `import('@sentry/node')` **only when `SENTRY_DSN` is
  set**. With no DSN (local dev, CI, tests) the facade is an inert no-op and the SDK is never imported — so
  the hot path, the test suite, and the production build are unaffected until a DSN is configured. (We use
  the **Node SDK** for a stable runtime API in Vercel's Node functions; `@sentry/nextjs` is kept as a dep for
  the source-map / `withSentryConfig` path below.)
- **Init** happens once at server startup from `instrumentation.ts` (`register()`, Node runtime only). Once
  Sentry is initialized, its default integrations also capture **unhandled exceptions and unhandled promise
  rejections**; Next's `onRequestError` is forwarded to the facade too.
- **Release-tied.** Events carry `release: getCurrentRelease()` (the same SHA we stamp on observability
  events), so Sentry's release-regression view answers "did this deploy break it?".
- **Context.** Route catches report unexpected/upstream failures (not plain bad-input) with `route`,
  `requestId`, `journeyId`, and `errorCode` (mapped to Sentry tags/extra); `subject` (userId/ip) maps to the
  Sentry user.
- **Manual capture.** Anywhere server-side: `import { captureException, captureMessage } from
  '@/lib/utils/error-reporting'` — both are no-ops until configured and never throw.

**Env vars:** `SENTRY_DSN` (required to enable), `SENTRY_ENVIRONMENT` (optional; falls back to `VERCEL_ENV`
→ `NODE_ENV`). **Source maps (optional, later):** for un-minified stack traces, wrap `next.config.ts` with
`withSentryConfig` (`@sentry/nextjs`) and set `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` in CI /
Vercel. Errors are captured **without** this; you just get minified frames until it's wired. Deliberately
not enabled now to keep the verified-green build untouched.

### Health / readiness endpoint (`GET /api/health`) — implemented

A lightweight liveness/readiness probe (`app/api/health/route.ts`). Cheap (two small reads), fast (each
check time-boxed to 2s), and **safe to expose** — no secrets, no env values, no error strings (failure
detail is logged server-side, never returned). Returns:

```jsonc
{
  "status": "ok" | "degraded" | "error",
  "release": "<short sha | 'unknown'>",
  "checks": {
    "database":         { "ok": true, "latencyMs": 67 },          // Supabase ping (tiny read of `platforms`)
    "distributedStore": { "ok": true, "latencyMs": 0, "backend": "memory" | "redis" }
  },
  "flags": { "explanations_llm": true },                          // resolved config snapshot
  "timestamp": "…"
}
```

HTTP status: **200** when the DB is reachable (the app can serve recommendations) — even if the store is
down, since the store is fail-open (→ `degraded`); **503** only when the DB is unreachable (→ `error`, not
ready). `Cache-Control: no-store`. Point an uptime monitor / the Vercel health check at it; `backend`
confirms whether distributed state (Upstash) is actually active, and `release`/`flags` give a one-glance
"which version + config am I hitting?" — handy for canary checks. Not rate-limited (it's a cheap probe).

---

## 7. Future: app-store / mobile distribution

We are web-only today. The moment a non-web client exists, the rules tighten because **you cannot force a
native app to update** — old versions live on user devices for months.

- **[P0-when-mobile] Version the APIs before any non-web client ships.** Move to `/api/v1/...` and commit to
  **N-1 (ideally N-2) compatibility**: the server supports the previous app version(s) until adoption drops
  off. This is non-negotiable for native clients and cheap to do now while there's one caller.
- **Min-version gate.** Accept an `x-app-version` header; if below a server-configured floor (a flag!),
  return a structured "please update" response the client renders as a soft/hard upgrade prompt.
- **OTA updates.** Prefer a stack that supports over-the-air JS pushes that bypass store review:
  - **Expo / React Native + EAS Update** — push JS/asset changes OTA; only native-module changes need a store
    submission. Closest mobile analog to Vercel's instant web updates.
  - Or a **thin native shell over the web app** (Capacitor/PWA-in-a-shell) — then most updates are just web
    deploys and "users get the update on next launch" carries over directly. Simplest path; trade-off is
    less-native feel and store policies on web-wrapper apps.
- **Server-authoritative everything** (already our posture) is the key enabler: the more logic lives on the
  server behind a versioned API, the less is frozen in a shipped binary, and the more we can fix without a
  store release.

---

## 8. Recommended tooling & patterns ("one-click restart with the updated version")

For **web**, that experience already exists via Vercel's atomic immutable deploys + Instant Rollback — the
user's next request is the new version, no action required. To make *triggering* updates safe and to extend
the experience:

| Need | Lean choice (start here) | Heavier option (later) |
|---|---|---|
| CI safety gate | GitHub Actions: type-check + lint + test, required on PR | Vercel Checks integration |
| Migrations | Supabase CLI + `config.toml` + ledger; expand/contract by hand | Atlas/Sqitch, automated in CI w/ branch DBs |
| Preview DB | Supabase **database branching** per PR | Full ephemeral staging stack |
| Feature flags | Home-grown `lib/flags.ts` over Upstash, server-evaluated, deterministic bucketing | Vercel Flags + Edge Config → LaunchDarkly/Statsig |
| Gradual rollout | % bucketing via flags; promote green preview → prod | Vercel canary alias / split traffic |
| Kill switch | Upstash-backed flag flip (instant, no redeploy) | Same via Edge Config |
| Observability | Release+flag stamp on events; Sentry; log drain | Datadog/Grafana SLOs + automated rollback |
| Rollback | Vercel Instant Rollback (re-alias previous build) | Automated rollback on SLO breach |

**Patterns to standardize:** expand/contract migrations; version-prefixed keys/caches; server-evaluated
flags; append-only response contracts; release-stamped telemetry; promote-don't-push.

---

## Prioritized plan & concrete next steps

**P0 — do before we rely on frequent prod changes**
1. ~~CI gate on PRs (`type-check && lint && test`)~~ **DONE** — `.github/workflows/ci.yml` (adds a `build`
   step too). Remaining: flip on GitHub branch protection to make it a *required* check for `main`.
2. ~~Adopt Supabase CLI migrations + a `schema_migrations` ledger; backfill 001–008; document
   expand → deploy → contract.~~ **DONE** — `config.toml`, `npm run db:*` wrappers,
   `supabase/migrations/README.md`, and a CI `migrations` check (`scripts/check-migrations.mjs`). Remaining:
   the one-time `supabase link` + `npm run db:baseline` against prod (needs DB creds).
3. Stamp `release` (commit SHA) + resolved `flags` on every structured event in
   `lib/utils/observability.ts`. *(small, additive)*
4. Add Sentry (or equivalent) for exception capture + release health.

**P1 — gradual-rollout capability**
5. ~~Implement `lib/flags.ts` (server-evaluated, Upstash-backed, fail-open, deterministic % bucketing).~~
   **DONE** — first flag `explanations_llm` (LLM kill switch) wired into the explanation route; env +
   store + % rollout supported; resolved flags now stamped on both observability events (§3/§6).
6. Version-prefix distributed-store keys and the explanation-cache key (`cb:v1:`, `rl:v1:`, `e1:`), so
   shape changes across a rollout are clean cutovers.
7. Add `preferences.schemaVersion` + migrate-on-read for user preferences.
8. Define golden-signal thresholds + a dashboard + log drain; write the Instant-Rollback runbook.

**P2 — when mobile is on the roadmap**
9. Introduce `/api/v1/...` versioning + N-1 compatibility policy + `x-app-version` min-version gate (a flag).
10. Choose the mobile delivery model (Expo+EAS Update for OTA, or web-shell) and document the update story.

---

## New RAL items surfaced by this review

- **RAL: CI safety gate** — ✅ implemented (`.github/workflows/ci.yml`: type-check/lint/test/build on
  push+PR to main). Follow-up: make it a *required* branch-protection check on `main`; later add
  `--max-warnings 0` (after clearing the pre-existing warning) and migration checks (see migrations RAL). *(P0)*
- **RAL: Automated, ledgered DB migrations** — ✅ implemented (Supabase CLI + `config.toml` + `db:*`
  scripts + `supabase/migrations/README.md` + CI `migrations` check enforcing expand/contract). Follow-ups:
  run the one-time `supabase link` + `npm run db:baseline` against prod (DB creds needed); optionally add the
  per-PR preview-branch apply (P1 above). *(P0)*
- **RAL: Release & flag stamping in observability** — ✅ implemented. `flags` (resolved set, success path)
  and `release` (commit SHA / RELEASE env, every terminal path) on both `recommendation_request` and
  `explanation_request`. *(P0)*
- **RAL: Error tracking / release health** — ✅ implemented (`lib/utils/error-reporting.ts` fail-open facade
  over `@sentry/node`, lazy on `SENTRY_DSN`, release-tied, wired into route catches + `instrumentation.ts`).
  Follow-ups: set `SENTRY_DSN` in Vercel; optionally enable source-map upload (`withSentryConfig` +
  `SENTRY_AUTH_TOKEN`). *(P0)*
- **RAL: Health / readiness endpoint** — ✅ implemented (`GET /api/health`: DB ping + store reachability +
  release + flags; 503 when DB down). Follow-up: point an uptime monitor at it; add an authenticated
  end-to-end smoke test (the DB paths the integration suite still skips). *(P0)*
- **RAL: Server-evaluated feature-flag layer** — ✅ implemented (`lib/flags.ts`: env/store/registry
  precedence, deterministic % rollout, fail-open, ~30s cache; `explanations_llm` kill switch wired into the
  explanation route; resolved flags stamped on both observability events). Follow-up: add a flag for the next
  explanation-prompt change paired with a cache-key bump. *(P1)*
- **RAL: Version-prefix shared keys & caches** — `cb:v1:`/`rl:v1:`/`e1:` for clean rollout cutovers. *(P1)*
- **RAL: User-data schema versioning** — `preferences.schemaVersion` + migrate-on-read. *(P1)*
- **RAL: Rollout SLOs + Instant-Rollback runbook** — thresholds, dashboard, log drain. *(P1)*
- **RAL: API versioning + min-version gate (pre-mobile)** — `/api/v1`, N-1 compat, `x-app-version`. *(P2)*
- **RAL: Mobile delivery & OTA strategy** — Expo+EAS Update vs web-shell decision. *(P2)*
