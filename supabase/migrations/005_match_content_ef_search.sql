-- WatchWise — Fix HNSW recall cap in match_content
-- Migration: 005_match_content_ef_search
--
-- pgvector's HNSW index defaults to hnsw.ef_search = 40, which caps the number of rows
-- an index-backed query returns — regardless of the LIMIT / match_count requested. Once the
-- catalog grew past a few hundred titles the planner switched from exact scan to the HNSW
-- index, so match_content(match_count => 100) silently returned only 40 candidates.
--
-- Fix: raise ef_search for the duration of the function via the function-level SET clause.
-- ef_search must be >= the largest match_count we request (MAX_CANDIDATE_LIMIT = 200), so we
-- set 200. Higher ef_search = better recall at a small latency cost; 200 is comfortable here.

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
  similarity          double precision
)
language sql
stable
set search_path = public
set hnsw.ef_search = 200
as $$
  select
    c.id, c.tmdb_id, c.title, c.type, c.release_year, c.description,
    c.genres, c.mood_tags, c.theme_tags, c.cast_names, c.director_names,
    c.runtime_minutes, c.avg_episode_minutes, c.season_count,
    c.imdb_rating, c.tmdb_rating, c.tmdb_vote_count,
    c.poster_url, c.backdrop_url, c.original_language, c.content_rating,
    1 - (c.embedding <=> query_embedding) as similarity
  from content c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit greatest(1, match_count)
$$;

grant execute on function match_content(vector, integer) to anon, authenticated, service_role;
