# WatchWise — Project Standards & Architecture Reference

> This file is the canonical source of truth for all coding conventions, architecture decisions, and project-specific rules.
> **Keep this file updated** whenever conventions or architecture decisions change. Every new contributor (human or AI) reads this first.

---

## Product Vision

WatchWise is a **decision-fatigue elimination tool** for streaming. The core value proposition:

> Open the app, express what you want in natural language, receive 5-8 high-quality, explainable recommendations from Netflix/Prime/Disney+, and commit to watching something in under 60 seconds.

We are **not** a content browser or "where to watch" search tool (that's JustWatch/Reelgood). We are a **decision-making assistant** with a calm, intelligent, warm personality. Every product and engineering decision must serve this goal.

**Tone:** Calm, intelligent, helpful, slightly warm. Like a knowledgeable friend who knows your taste.
**Anti-patterns:** Flashy animations, overwhelming content, pushy upsells, generic recommendations without explanations.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | SSR, API routes, file-based routing |
| Language | TypeScript (strict mode) | `tsconfig.json` with `strict: true` |
| Styling | Tailwind CSS + shadcn/ui + Radix UI | Accessible primitives, design tokens |
| Animation | Framer Motion | Tasteful micro-interactions only |
| Server State | TanStack Query v5 | All async data fetching and mutations |
| Forms | React Hook Form + Zod | Type-safe, performant |
| Icons | lucide-react | Consistent with shadcn/ui |
| Database | Supabase (PostgreSQL + pgvector) | Auth, Storage, RLS all via Supabase |
| Embeddings | Voyage AI (voyage-3-lite, 512-dim) | Purpose-built retrieval embeddings |
| LLM | Anthropic Claude (claude-haiku-4-5) | NL parsing + explanation generation |
| Background Jobs | Inngest | Data sync pipeline, batch embedding |
| Hosting | Vercel (frontend) + Supabase Cloud | Preview deploys on every PR |

---

## Architecture Decisions

### ADR-001: Next.js monorepo (no separate backend)
The recommendation engine at MVP scope (LLM call → vector search → scoring → LLM call) maps cleanly to Next.js API routes. No separate Python service until we need custom ML models that require scikit-learn/PyTorch pipelines. Revisit at 10k MAU.

### ADR-002: pgvector over Pinecone at MVP
512-dim Voyage embeddings at catalog scale (~50k titles) fit comfortably in pgvector. This eliminates a separate service, keeps data co-located, and simplifies queries (SQL JOIN instead of cross-service calls). Migrate to Pinecone if we exceed 500k vectors or need ANN at sub-5ms.

### ADR-003: Claude Haiku for explanations (no mandatory intent parsing in v1)
Haiku (claude-haiku-4-5) is used for generating per-result explanations, cached by (content_id + query_hash). In MVP v1 we skip structured intent parsing — the raw query string is embedded directly by Voyage AI. Intent parsing (decomposing the query into genres/mood/ref-titles) is a planned v2 enhancement, not a v1 requirement. Upgrade to Sonnet only if explanation quality is demonstrably insufficient.

### ADR-006: Simplified recommendation pipeline for MVP
The full 8-step pipeline (with separate intent parsing, composite 4-factor scoring, etc.) is deferred to post-launch. MVP uses a 5-step pipeline: embed query → vector retrieval → hard filters → personalization boost → explanation generation. This is modular — each step is in its own file under `lib/recommendations/` and can be upgraded independently. The architecture must not be simplified in ways that would require rewrites to add the advanced steps later.

### ADR-004: Voyage AI voyage-3-lite for embeddings
Better semantic retrieval quality than OpenAI text-embedding-3-small for our use case (Anthropic-recommended). 512 dimensions keeps pgvector index small. Pre-computed on ingestion; never computed at query time.

### ADR-005: Inngest for background jobs
Superior to raw cron: retry logic, observability, replay, local dev server, generous free tier. All data sync (Streaming API, TMDb enrichment, embedding computation) runs through Inngest functions.

---

## Data Sources

### Streaming Availability API (movieofthenight.com)
- **Purpose:** Primary source for what is currently available on Netflix, Prime Video, Disney+ in US
- **Data:** Title presence, deep links, availability windows (added/expiring dates), genres, cast, images
- **Sync frequency:** Daily (catalog) + triggered on-demand for new titles
- **Rate limits:** Respect limits; implement exponential backoff
- **Key env var:** `STREAMING_API_KEY`

### TMDb (The Movie Database)
- **Purpose:** Rich metadata enrichment — full plot, cast, crew, keywords, similar titles, ratings
- **Data:** Description, keywords (used to derive mood/theme tags), ratings, runtime, seasons
- **Sync frequency:** Once per title on first ingest; re-sync if `updated_at` is >30 days old
- **Rate limits:** 40 req/10s on free tier; use request queue in pipeline
- **Key env var:** `TMDB_API_KEY`

### Derived Data (computed by us)
- **mood_tags**: Derived from TMDb keywords (e.g., "dark-humor", "slow-burn", "feel-good")
- **theme_tags**: High-level themes (e.g., "heist", "family", "workplace", "revenge")
- **embedding_input**: Constructed string fed to Voyage AI (see embedding-pipeline.ts for format)

---

## Recommendation Engine Principles

> **MVP approach (v1):** Simplified 5-step pipeline. Modular by design so each step can be upgraded independently without architectural rewrites. See `docs/recommendation-engine.md` for full detail.

### Pipeline Steps — MVP v1 (in order)
1. **Embed Query** — Voyage AI (`voyage-3-lite`) embeds the raw user query string directly into a 512-dim vector. No structured intent parsing required in v1.
2. **Vector Retrieval** — pgvector cosine similarity (`<=>` operator) against `content.embedding`, returns top 100 candidates.
3. **Hard Filters** — Platform availability (must be on user's subscribed platforms), region, content type, runtime constraint, already-seen exclusions.
4. **Personalization Boost** — Score adjusted by semantic similarity to user's taste seeds (`user_taste_seeds`). Loved titles boost similar candidates; disliked titles penalize overlapping genres/tags.
5. **Explanation Generation** — Claude Haiku generates a 1-2 sentence "why this" explanation per result, cached by `(content_id, query_hash)`. Return top 5-8.

### Folder Structure — `lib/recommendations/`
```
lib/recommendations/
├── engine.ts         # Thin orchestrator — calls each step in sequence
├── retrieval.ts      # Voyage embed + pgvector cosine search
├── filters.ts        # All hard filters as composable predicates
├── scoring.ts        # Personalization boost using taste seeds
└── explanations.ts   # Claude explanation generation + cache logic
```

### Scoring Formula — v1
```
score = (vector_similarity   × 0.60)   # Semantic match to query
      + (personalization     × 0.25)   # Taste seed similarity
      + (quality_score       × 0.15)   # Normalized TMDb/IMDB rating
```

### Planned v2 Enhancements (do not pre-implement)
- Structured intent parsing (Claude Haiku → `ParsedIntent` JSON) to improve genre/mood filtering
- Additional scoring signals: recency, watch-time patterns, user feedback history
- Genre-match factor in composite score
- Collaborative filtering layer

### Non-Negotiable Rules for the Rec Engine
- **Every recommendation must include a human-readable explanation.** No result ever shown without "why this."
- **Log the full score_breakdown for every recommendation** in the `recommendations` table for debugging and iteration.
- **Never recommend content not currently available** on the user's selected platforms.
- **Cache LLM calls aggressively.** Explanations cached by `(content_id + query_hash)` pair (24h TTL).
- **Build modularly.** Each step in `lib/recommendations/` must be independently testable and replaceable.

---

## Database Schema

Full schema lives in `supabase/migrations/001_initial_schema.sql`. Key tables:

| Table | Purpose |
|---|---|
| `platforms` | Netflix, Prime Video, Disney+ catalog |
| `content` | All movie/series metadata + `embedding vector(512)` |
| `content_platforms` | M2M: which title is on which platform (with deep links, windows) |
| `user_profiles` | Extends Supabase `auth.users` |
| `user_taste_seeds` | Titles rated during onboarding (loved/liked/disliked) |
| `recommendation_sessions` | Each query the user makes |
| `recommendations` | Results per session with score_breakdown + explanation |
| `recommendation_feedback` | User feedback (loved/disliked/already-seen) |
| `sync_jobs` | Tracks background job runs for observability |

Row Level Security (RLS) is enabled on all user-facing tables. Service role key used only in background jobs.

---

## Coding Conventions

### TypeScript
- `strict: true` always. No `any`. No `@ts-ignore` without a comment explaining why.
- Prefer `type` over `interface` for data shapes. Use `interface` only for extensible contracts.
- All API request/response types defined in `lib/types/api.ts` with Zod schemas in `lib/validators/`.
- Zod schemas are the single source of truth for validation. Types are inferred from schemas with `z.infer`.

### Functions
- Small, focused, pure where possible.
- Name clearly: `generateRecommendationExplanation`, not `genExp`.
- Async functions always return typed Promises. Never `Promise<any>`.
- All public functions in `lib/` must have a JSDoc comment when the behavior is non-obvious.

### Comments
- **Default: no comments.** Well-named identifiers are self-documenting.
- Add a comment only when the WHY is non-obvious: hidden constraints, workarounds, subtle invariants.
- Never describe WHAT the code does. Never reference the current task or PR.

### Error Handling
- Never swallow errors silently. Always log (structured) or re-throw.
- User-facing errors must be human-readable and calm (match app tone).
- Use `Result`-style returns for operations that can gracefully fail rather than throwing.
- All API routes have try/catch with structured error responses.

### File Headers
Every file in `lib/` and `components/` begins with a one-line comment stating its responsibility:
```typescript
// Composite scoring function — computes weighted recommendation score with auditable breakdown.
```

### Imports
- Absolute imports via `@/` alias (configured in tsconfig.json).
- Order: React → Next.js → third-party → internal types → internal utilities → relative

---

## UI/UX Principles

### Decision-Fatigue Reduction
- **5-8 recommendations maximum.** Never overwhelm. Quality over quantity.
- **One primary action per screen.** No competing calls to action.
- **"Surprise me" must actually work.** Smart default seeded from user taste.
- **Refinement is one interaction.** "More like this" / "Only on Netflix" — not a new query.

### Visual Design
- Calm, high-contrast, spacious. Tailwind design tokens enforced consistently.
- Cards carry the most cognitive weight — poster, title, explanation, platform badge, feedback controls.
- Loading states use skeleton screens (never spinners alone).
- Empty states are friendly and actionable, never blank.

### Performance
- Target Largest Contentful Paint < 2.5s on 4G mobile.
- Recommendation cards lazy-load images (`loading="lazy"` + blur placeholder from TMDb).
- TanStack Query stale-while-revalidate for recommendations.
- Explanation text streamed where possible to reduce perceived latency.

### Accessibility
- WCAG 2.2 AA minimum. Every interactive element has an accessible label.
- Full keyboard navigation (Radix UI primitives handle most of this).
- Focus management after async updates.
- No color-only communication of state (always pair with text or icon).

---

## Testing

### Standards
- All non-trivial logic in `lib/` must have unit tests (Vitest).
- Recommendation scoring and filters are especially critical — test edge cases.
- Use `@testing-library/react` for component tests. Test behavior, not implementation.
- Integration tests for the full recommendation pipeline (mock LLM calls, real Supabase in test mode).

### Test File Location
- Unit tests: `tests/unit/{module-path}/filename.test.ts` (mirrors `lib/` structure)
- Component tests: co-located as `ComponentName.test.tsx` next to component (optional)
- Integration: `tests/integration/`

---

## Security

- **No secrets in code or committed `.env` files.** Use `.env.local` (gitignored) or Vercel env vars.
- **All user inputs validated with Zod** before processing.
- **Supabase RLS** enforced on all user-data tables. API routes verify user identity via Supabase server client.
- **Rate limiting** on recommendation API route (to protect LLM costs).
- **Service role key** used only in Inngest functions / server-side sync jobs, never in browser-callable code.

---

## Performance & Cost

- **Cache LLM calls:** intent parsing cached by query hash (5-min TTL), explanations cached by content+intent hash (24h TTL).
- **Pre-compute embeddings:** never compute at query time. Always at ingestion.
- **Batch TMDb calls** during enrichment. Respect rate limits.
- **TanStack Query caching:** recommendations cached for 2 minutes client-side (users rarely want to re-query within same session).
- **Monitor Voyage AI and Claude costs** weekly in first month post-launch.

---

## Git Workflow

### Branch Strategy
- `main` — always deployable to production
- `feature/short-description` — feature branches
- `fix/short-description` — bug fixes
- `chore/short-description` — infrastructure, dependencies

### Commit Messages (Conventional Commits)
```
feat: add natural language query input to discovery screen
fix: handle empty platform filter in scoring pipeline
chore: update TMDb client to use v3 images endpoint
refactor: extract explanation caching to dedicated module
test: add scoring unit tests for edge cases
docs: update architecture.md with ADR-003
```

### PR Rules
- Each PR should be one logical unit of change.
- Self-review against this CLAUDE.md before requesting review.
- Update this file or `docs/architecture.md` if the PR changes architectural decisions.

---

## Environment Variables

See `.env.example` for the full list. Required for local dev:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server/jobs only, never exposed to browser)
- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`
- `STREAMING_API_KEY`
- `TMDB_API_KEY`
- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`

---

## Onboarding Flow (MVP)

1. **Welcome screen** — value prop + sign up / sign in
2. **Platform selection** — Which of Netflix / Prime / Disney+ do you subscribe to?
3. **Taste seeding** — Rate 8 titles (liked / loved / disliked). Curated selection covering genre variety.
4. **Ready** — Animated transition to main discovery screen with first recommendations already loading.

Onboarding data stored in `user_profiles.preferred_platforms` and `user_taste_seeds`. Onboarding skippable after step 2 (platform selection is the minimum required for filtering to work).

---

*Last updated: 2026-06-04 — Simplified MVP recommendation pipeline (ADR-006); API keys configured*
