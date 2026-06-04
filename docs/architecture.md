# WatchWise — Architecture

## System Overview

WatchWise is a Next.js 15 full-stack application with Supabase as the data/auth backbone and Inngest for background data sync.

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React / Next.js App Router)                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Discovery Screen → Query Input → Recommendation Cards   │  │
│  │  TanStack Query caches results, optimistic feedback UI   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS API calls
┌────────────────────────────▼────────────────────────────────────┐
│  Next.js API Routes (Vercel Edge/Node)                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  /api/recommendations  — Main rec pipeline endpoint     │   │
│  │  /api/feedback         — User feedback ingestion        │   │
│  │  /api/inngest          — Inngest webhook handler        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  lib/recommendations/     — Recommendation engine               │
│  lib/ai/                  — Claude + Voyage AI clients          │
│  lib/data/                — Supabase client wrappers            │
└────────────────────────────┬────────────────────────────────────┘
                             │
       ┌─────────────────────┼──────────────────────┐
       ▼                     ▼                      ▼
┌─────────────┐   ┌──────────────────┐   ┌─────────────────────┐
│  Supabase   │   │  Anthropic API   │   │  Voyage AI API      │
│  PostgreSQL │   │  claude-haiku    │   │  voyage-3-lite      │
│  + pgvector │   │  Intent parsing  │   │  512-dim embeddings │
│  + Auth     │   │  Explanations    │   │                     │
└─────────────┘   └──────────────────┘   └─────────────────────┘

Background (Inngest)
┌─────────────────────────────────────────────────────────────────┐
│  sync-streaming-catalog.ts  — Daily catalog sync                │
│  enrich-with-tmdb.ts        — Per-title metadata enrichment     │
│  compute-embeddings.ts      — Batch Voyage AI embedding         │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
  Streaming API           TMDb API           Voyage AI API
  (RapidAPI)
```

## Request Lifecycle — Recommendation Query

1. User types query in `QueryInput` component
2. `useRecommendations` hook (TanStack Query) fires `POST /api/recommendations`
3. API route validates request with Zod (`lib/validators/query.ts`)
4. `engine.ts` orchestrates the pipeline:
   a. `intent-parser.ts` → Claude Haiku returns `ParsedIntent`
   b. `vector-search.ts` → Voyage AI embeds intent, pgvector returns top 150 candidates
   c. `filters.ts` → Platform/region/runtime hard filters reduce to ~40 candidates
   d. `scoring.ts` → Composite score with breakdown for each candidate
   e. Top 8 selected; `explanations.ts` → Claude Haiku generates per-result explanations (cached)
5. API returns `RecommendationResult[]` with full score_breakdown and explanation
6. `RecommendationList` renders with stagger animation
7. Session + results written to Supabase async (non-blocking to response)

## Data Sync Lifecycle

1. Inngest cron triggers `sync-streaming-catalog` daily
2. Function calls Streaming Availability API for all 3 platforms, US region
3. New/changed titles trigger `enrich-with-tmdb` events (per title)
4. TMDb enrichment derives `mood_tags` and `theme_tags` from keyword mapping
5. Enriched titles trigger `compute-embeddings` events (batched, 100 at a time)
6. Embeddings stored in `content.embedding` (vector(512)) column
7. Stale platform availability records (>25h old) marked inactive

## Caching Strategy

| Data | Cache | TTL | Location |
|---|---|---|---|
| Recommendation results | TanStack Query | 2 min | Browser |
| Parsed query intent | Server Map (by query hash) | 5 min | API process |
| Recommendation explanations | DB (`recommendations.explanation`) | 24 h | Supabase |
| Content metadata | pgvector + SQL | Until sync | Supabase |
| Platform availability | SQL | Until daily sync | Supabase |

## Deployment

- **Frontend**: Vercel (automatic deploy on push to `main`)
- **Database**: Supabase Cloud (us-east region)
- **Background Jobs**: Inngest Cloud (serverless, event-driven)
- **Preview Deploys**: Vercel preview URL on every PR (uses same Supabase instance, separate Inngest env)
