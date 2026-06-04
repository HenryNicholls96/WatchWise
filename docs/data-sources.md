# WatchWise — Data Sources & Sync Strategy

## Overview

| Source | What We Get | Sync Frequency | Free Tier |
|---|---|---|---|
| Streaming Availability API | Platform catalog, availability windows, deep links | Daily | 100 req/day |
| TMDb | Rich metadata: plot, cast, keywords, ratings, similar | Once per title | ~40 req/10s |
| Voyage AI | Embedding vectors (512-dim) | Once per title, on update | $0.000016/token |
| Claude Haiku | NL intent parsing, explanations | Per query (cached) | Pay-per-use |

## Streaming Availability API

**Provider**: movieofthenight.com (via RapidAPI)  
**Docs**: https://docs.movieofthenight.com/  
**Env**: `STREAMING_API_KEY`, `STREAMING_API_HOST`

### Endpoints Used

- `GET /shows/search/filters` — Search by country + platform with pagination
- `GET /shows/{type}/{tmdb-id}` — Single title detail (used for delta sync)

### Sync Strategy

1. **Full catalog sync** (daily, 02:00 UTC via Inngest cron)
   - Iterate paginated results for `country=us`, platforms: `netflix,prime,disney`
   - Upsert into `content` and `content_platforms` tables
   - Mark records not returned in this sync as `available_until = now()` (expired)

2. **Delta sync** (triggered when embedding pipeline flags new content)
   - Re-check availability for titles whose `content_platforms.updated_at > 24h`

### Rate Limit Handling

Streaming API free tier: 100 requests/day. For full catalog (Netflix US alone is ~5,000+ titles), upgrade to a paid plan is required before launch. In development, use cached fixture responses.

### Key Fields We Store

```
tmdb_id, title, type (movie/series), genres, cast, backdrop_url, 
poster_url, deep_link, available_from, available_until, streaming_type
```

## TMDb (The Movie Database)

**Docs**: https://developer.themoviedb.org/docs  
**Env**: `TMDB_API_KEY`, `TMDB_API_READ_TOKEN`  
**Base URL**: `https://api.themoviedb.org/3`

### Endpoints Used

- `GET /movie/{tmdb_id}` — Full movie details
- `GET /tv/{tmdb_id}` — Full TV series details
- `GET /movie/{tmdb_id}/keywords` — Keywords (used for mood/theme tag derivation)
- `GET /tv/{tmdb_id}/keywords` — Same for series
- `GET /movie/{tmdb_id}/credits` — Full cast and crew
- `GET /tv/{tmdb_id}/credits` — Same for series

### Mood/Theme Tag Derivation

TMDb keywords are mapped to our internal `mood_tags` and `theme_tags` via a lookup table in `lib/utils/constants.ts`.

Example mappings:
```
"dark humor"        → mood_tag: "dark-comedy"
"slow burn"         → mood_tag: "slow-burn"
"heist"             → theme_tag: "heist"
"workplace"         → theme_tag: "workplace"
"feel good"         → mood_tag: "feel-good"
"psychological"     → mood_tag: "psychological"
```

New keywords that don't map to existing tags are logged to `sync_jobs.metadata` for manual review and tag expansion.

### Enrichment Pipeline

See `lib/sync/enrichment-pipeline.ts`. For each new content item:
1. Fetch movie/TV details (description, runtime, seasons, language, content rating)
2. Fetch keywords → derive `mood_tags` and `theme_tags`
3. Fetch credits → extract top 5 cast names + director names
4. Build `embedding_input` string
5. Write to `content` table, trigger embedding computation event

### Rate Limits

Free tier: ~40 requests per 10 seconds. Enforced via `p-throttle` in the TMDb client wrapper.

## Voyage AI

**Docs**: https://docs.voyageai.com  
**Env**: `VOYAGE_API_KEY`  
**Model**: `voyage-3-lite` (512-dim, optimized for retrieval)

### When Embeddings Are Computed

- On new title ingestion (after TMDb enrichment completes)
- On title re-enrichment (if `mood_tags` or description changes significantly)
- **Never** at query time — only pre-computed at ingestion

### Embedding Input Format

```
Title: {title}. Type: {movie|series}. Genres: {genre1, genre2}. 
Mood: {mood_tag1, mood_tag2}. Themes: {theme_tag1}. 
Description: {first_500_chars_of_description}. 
Cast: {cast1, cast2, cast3, cast4, cast5}. 
Keywords: {top_10_tmdb_keywords}.
```

This format is stored verbatim in `content.embedding_input` for auditability.

### Query Embedding

The `ParsedIntent.embedding_string` is embedded at query time with the same model. This is the only runtime embedding call per query.

Cost: voyage-3-lite charges $0.000016/1k tokens. Each query embedding is ~50 tokens ≈ $0.0000008. Negligible.

## Claude (Anthropic)

**Model**: `claude-haiku-4-5`  
**Env**: `ANTHROPIC_API_KEY`

### Uses

1. **Intent parsing** (per query, cached by normalized hash)
   - Input: ~200 token prompt + ~50 token user query
   - Output: ~100 token JSON struct
   - Cost: ~$0.00015 per uncached call

2. **Explanation generation** (per recommendation result, cached 24h)
   - Input: ~400 token prompt + content + query context
   - Output: ~80 token explanation string
   - Cost: ~$0.0004 per uncached call; 8 results × $0.0004 = $0.003 max per session

### Caching Implementation

- **Intent parsing**: In-process `Map<queryHash, {intent, expiry}>`, 5-min TTL
- **Explanations**: Stored in `recommendations.explanation` DB column, indexed by (content_id, intent_hash)

At scale, replace in-process cache with Upstash Redis for multi-instance safety.
