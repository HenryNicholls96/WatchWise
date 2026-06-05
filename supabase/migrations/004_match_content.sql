-- WatchWise — Vector Similarity Search Function
-- Migration: 004_match_content
--
-- pgvector cosine similarity cannot be expressed through PostgREST directly, so the
-- retrieval layer calls this function via supabase.rpc('match_content', ...).
--
-- Returns the top `match_count` titles by cosine similarity to the query embedding,
-- INCLUDING a similarity score in [−1, 1] (1 = identical direction). The 512-float
-- `embedding` column is deliberately NOT returned — it is large and never used downstream.
--
-- Uses the HNSW cosine index (vector_cosine_ops) created in migration 001, so the
-- `<=>` (cosine distance) ordering is index-accelerated.

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

-- Callable by the anon/authenticated roles (content is public-read; no user data exposed).
grant execute on function match_content(vector, integer) to anon, authenticated, service_role;
