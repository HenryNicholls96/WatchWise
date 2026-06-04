# WatchWise — Recommendation Engine

## Design Philosophy

The MVP engine is intentionally simple and fast to build, while being modular enough that every component can be upgraded independently. The architecture follows one rule: **no step should know or care about the implementation of any other step.**

Every recommendation must:
1. Be currently available on the user's subscribed platforms
2. Come with a human-readable explanation ("Recommended because...")
3. Have an auditable score breakdown logged to the database

---

## MVP Pipeline (v1)

```
User Query (raw text or structured filters)
     │
     ▼
[1] EMBED QUERY
    Voyage AI voyage-3-lite → 512-dim float vector
    lib/recommendations/retrieval.ts
     │
     ▼
[2] VECTOR RETRIEVAL
    pgvector cosine similarity → top 100 candidates
    lib/recommendations/retrieval.ts
     │
     ▼
[3] HARD FILTERS
    Platform availability, region, type, runtime, seen
    lib/recommendations/filters.ts
     │
     ▼
[4] PERSONALIZATION BOOST
    Taste seed similarity → adjusted scores
    lib/recommendations/scoring.ts
     │
     ▼
[5] EXPLANATION GENERATION
    Claude Haiku → cached "why this" per result
    lib/recommendations/explanations.ts
     │
     ▼
Top 5-8 RecommendationResult[]
```

---

## Module Contracts

Each module exports pure functions with well-defined inputs and outputs. This makes each step independently testable and swappable.

### `retrieval.ts`

```typescript
// Embeds query, searches pgvector, returns raw candidates with similarity scores.

type RetrievalInput = {
  queryText: string;       // raw user input — embedded as-is in v1
  limit?: number;          // default: 100
};

type Candidate = {
  content: ContentRow;
  vectorSimilarity: number; // 0.0–1.0 cosine similarity
};

async function retrieveCandidates(
  input: RetrievalInput,
  supabase: SupabaseClient
): Promise<Candidate[]>
```

**How it works:**
1. Call Voyage AI API with `queryText` → 512-dim embedding
2. Run `SELECT *, 1 - (embedding <=> $vec) AS similarity FROM content ORDER BY embedding <=> $vec LIMIT $limit`
3. Return results with similarity scores

**v2 upgrade path:** Add lightweight intent parsing before embedding to improve the query vector (e.g., augment query string with inferred genres/mood before embedding). No other step changes.

---

### `filters.ts`

```typescript
// Composable hard filters applied to candidates. Each filter is a pure predicate.

type FilterInput = {
  candidates: Candidate[];
  platformSlugs: string[];          // user's subscribed platforms
  region: string;                   // e.g., "us"
  contentType?: "movie" | "series"; // null = any
  maxRuntimeMinutes?: number;       // null = no limit
  excludeContentIds?: string[];     // already-seen + not-interested
};

async function applyHardFilters(
  input: FilterInput,
  supabase: SupabaseClient
): Promise<Candidate[]>
```

**Filters applied in sequence (each eliminates candidates):**
1. Platform availability — `content_platforms` record must exist for user's platforms + region
2. Content type — if specified, filter to `movie` or `series`
3. Runtime — if `maxRuntimeMinutes` set, exclude movies longer than limit
4. Already-seen / not-interested — exclude `content_id` in user's negative feedback history

---

### `scoring.ts`

```typescript
// Applies personalization boost to candidates using the user's taste seeds.

type ScoringInput = {
  candidates: Candidate[];
  tasteSeedEmbeddings: TasteSeedWithEmbedding[]; // loved/liked/disliked + their vectors
};

type ScoredCandidate = {
  content: ContentRow;
  score: number;           // final composite score 0.0–1.0
  scoreBreakdown: {
    vectorSimilarity: number;  // weight: 0.60
    personalization: number;   // weight: 0.25
    qualityScore: number;      // weight: 0.15
  };
};

function scoreAndRank(input: ScoringInput): ScoredCandidate[]
```

**Scoring formula:**
```
score = (vectorSimilarity × 0.60)
      + (personalization  × 0.25)
      + (qualityScore     × 0.15)
```

**Personalization boost:**
- For each taste seed the user rated `loved`: +boost if candidate vector cosine similarity > 0.75
- For each seed rated `liked`: +smaller boost if cosine similarity > 0.65
- For each seed rated `disliked`: penalty if `genres` overlap > 50%
- Boost values normalized to 0.0–1.0

**Quality score:**
- `min(tmdb_rating / 10.0, 1.0)` weighted by `log(vote_count)` to discount low-vote titles

---

### `explanations.ts`

```typescript
// Generates Claude Haiku explanations for each result. Cached by (content_id, queryHash).

type ExplanationInput = {
  results: ScoredCandidate[];
  queryText: string;
  queryHash: string;                         // SHA-256 of normalized query
  userTasteSeeds: TasteSeedWithTitle[];       // for "you liked X" references
};

type ResultWithExplanation = ScoredCandidate & {
  explanation: string;
  platformInfo: ContentPlatformRow;
};

async function generateExplanations(
  input: ExplanationInput,
  supabase: SupabaseClient
): Promise<ResultWithExplanation[]>
```

**Cache strategy:**
- Before calling Claude, check `recommendations` table for an existing `explanation` where `content_id = X AND intent_hash = queryHash`
- If found and not null: reuse it (24h TTL enforced by `created_at` check)
- If not found: batch Claude Haiku call for all uncached results (single API call with all contexts)

**Claude prompt structure:**
```
You are generating recommendation explanations for a streaming app.
For each title below, write a 1-2 sentence explanation of why it matches
the user's request. Be specific and reference the query and their taste.
Tone: warm, concise, confident.

User query: "{queryText}"
User liked: {seed_titles_they_loved_or_liked}

Titles to explain:
1. {title} — {genres}, {mood_tags}, {description_excerpt}
...

Respond with a JSON array: [{"content_id": "...", "explanation": "..."}, ...]
```

---

### `engine.ts`

```typescript
// Thin orchestrator — calls each step and passes outputs through the pipeline.

type RecommendationQuery = {
  queryText: string;
  userId: string;
  platformSlugs: string[];
  contentType?: "movie" | "series";
  maxRuntimeMinutes?: number;
};

type RecommendationResult = {
  content: ContentRow;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  explanation: string;
  platform: PlatformRow;
  deepLink: string;
};

async function getRecommendations(
  query: RecommendationQuery
): Promise<RecommendationResult[]>
```

The engine is intentionally thin. It:
1. Loads user's taste seeds (with their pre-computed embeddings)
2. Calls `retrieveCandidates`
3. Calls `applyHardFilters`
4. Calls `scoreAndRank` → slices to top 20 before explanation
5. Calls `generateExplanations` → slices final result to top 5-8
6. Persists session + results to DB (non-blocking, fire-and-forget)
7. Returns results

---

## Data Requirements

For the engine to work, the `content` table must have:
- `embedding` column populated (Voyage AI voyage-3-lite, 512-dim)
- `genres`, `mood_tags`, `theme_tags` populated (from TMDb enrichment)
- `tmdb_rating` and `tmdb_vote_count` for quality scoring
- Active `content_platforms` records for US + the three platforms

The pipeline to get there: TMDb ingest → enrichment → Voyage embedding → platform sync.

---

## Content Embedding Format

The string fed to Voyage AI at ingestion time (stored in `content.embedding_input`):

```
Title: {title}. Type: {movie|series}. Genres: {genre_list}.
Mood: {mood_tag_list}. Themes: {theme_tag_list}.
Description: {first_400_chars}. Cast: {top_5_cast}.
Keywords: {top_10_tmdb_keywords}.
```

The query string is embedded as-is (the raw user input). This asymmetry is intentional — Voyage AI's retrieval models handle query-document asymmetry well.

---

## v2 Planned Enhancements

These are NOT in scope for MVP. Architecture is designed to accommodate them without rewrites:

| Enhancement | Where it fits | Expected impact |
|---|---|---|
| Structured intent parsing | `retrieval.ts` — augment query before embedding | Better genre/mood targeting |
| Genre-match scoring factor | `scoring.ts` — add factor to formula | More precise scoring |
| Feedback-weighted personalization | `scoring.ts` — use post-session feedback | Improving taste model over time |
| Collaborative filtering | New `collaborative.ts` module + `scoring.ts` | Better cold-start discovery |
| Session-to-session preference memory | `engine.ts` — load full feedback history | Persistent taste evolution |
