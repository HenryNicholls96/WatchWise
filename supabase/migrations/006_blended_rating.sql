-- WatchWise — Blended Rating
-- Migration: 006_blended_rating
--
-- Adds storage for a blended "Rating" combining IMDb + Metacritic (via OMDb) + TMDb, computed by a
-- background enrichment step (scripts/blend-ratings.ts) and read by the UI. We store the final
-- blended value AND the per-source inputs (rating_sources jsonb) so weights can be re-tuned later
-- without re-fetching. imdb_id is needed to key OMDb lookups (TMDb external_ids → imdb_id).

alter table content
  add column if not exists imdb_id            text,
  add column if not exists blended_rating     numeric(5,2),   -- 0–100
  add column if not exists rating_sources     jsonb,          -- { imdb, metacritic, tmdb, contributing }
  add column if not exists ratings_updated_at timestamptz;

create index if not exists content_imdb_id_idx on content (imdb_id);
-- Staleness scans for the resumable enrichment job (nulls first = not-yet-rated).
create index if not exists content_ratings_updated_idx on content (ratings_updated_at);

-- Recreate match_content to also expose blended_rating + rating_sources (and keep the 005 ef_search
-- fix via runtime set_config). Signature/return-order otherwise unchanged; similarity stays last.
-- DROP first: CREATE OR REPLACE cannot change a function's return columns (the 005 version returns
-- fewer columns), so replacing in place fails with 42P13. Dropping and recreating is safe — the
-- function is only called via the match_content RPC.
drop function if exists match_content(vector, integer);

create or replace function match_content(
  query_embedding vector(512),
  match_count integer default 100
)
returns table (
  id                  uuid,
  tmdb_id             integer,
  title               text,
  type                text,
  release_year        integer,
  description         text,
  genres              text[],
  mood_tags           text[],
  theme_tags          text[],
  cast_names          text[],
  director_names      text[],
  runtime_minutes     integer,
  avg_episode_minutes integer,
  season_count        integer,
  imdb_rating         numeric,
  tmdb_rating         numeric,
  tmdb_vote_count     integer,
  poster_url          text,
  backdrop_url        text,
  original_language   text,
  content_rating      text,
  blended_rating      numeric,
  rating_sources      jsonb,
  similarity          double precision
)
language plpgsql
stable
set search_path = public
as $$
begin
  -- true = transaction-local, so this only affects the current query, not the whole session.
  perform set_config('hnsw.ef_search', '200', true);

  return query
    select
      c.id, c.tmdb_id, c.title, c.type, c.release_year, c.description,
      c.genres, c.mood_tags, c.theme_tags, c.cast_names, c.director_names,
      c.runtime_minutes, c.avg_episode_minutes, c.season_count,
      c.imdb_rating, c.tmdb_rating, c.tmdb_vote_count,
      c.poster_url, c.backdrop_url, c.original_language, c.content_rating,
      c.blended_rating, c.rating_sources,
      1 - (c.embedding <=> query_embedding) as similarity
    from content c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit greatest(1, match_count);
end;
$$;

grant execute on function match_content(vector, integer) to anon, authenticated, service_role;
