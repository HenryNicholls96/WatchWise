-- WatchWise — Explanation cache
-- Migration: 008_explanation_cache
--
-- Cross-request cache for Claude-generated "why this" explanations, so identical (title, query, taste)
-- combinations don't re-hit the LLM on every request. Keyed by `${content_id}:${query_hash}:${taste_sig}`
-- (see explanationCacheKey) — a deterministic, collision-resistant string.
--
-- Invalidation: TTL-based, enforced on READ (the adapter ignores rows older than 24h) and overwritten
-- on the next write (upsert). The key already encodes the query (query_hash) and the user's taste set
-- (taste_sig), so a changed query or taste naturally produces a new key. Stale rows are harmless; an
-- optional periodic cleanup of `created_at < now() - 24h` can reclaim space later.
--
-- Access: RLS enabled with NO policies, so anon/authenticated roles have zero access via the API and
-- only the service role (which bypasses RLS, used server-side only) can read/write. This keeps the
-- shared cache off the public API — no anon read/write, no cache poisoning.

create table if not exists explanation_cache (
  cache_key   text primary key,
  explanation text not null,
  created_at  timestamptz not null default now()
);

create index if not exists explanation_cache_created_idx on explanation_cache (created_at);

alter table explanation_cache enable row level security;
