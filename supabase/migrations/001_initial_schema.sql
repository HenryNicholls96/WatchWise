-- WatchWise — Initial Database Schema
-- Migration: 001_initial_schema
-- Run via: supabase db push (local) or applied automatically by Supabase cloud migrations

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "vector";

-- ─── Platforms ────────────────────────────────────────────────────────────────

create table if not exists platforms (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,                    -- "Netflix", "Prime Video", "Disney+"
  slug        text not null unique,             -- "netflix", "prime", "disney"
  logo_url    text,
  created_at  timestamptz not null default now()
);

insert into platforms (name, slug) values
  ('Netflix',      'netflix'),
  ('Prime Video',  'prime'),
  ('Disney+',      'disney')
on conflict (slug) do nothing;

-- ─── Content (movies + series) ────────────────────────────────────────────────

create table if not exists content (
  id                    uuid primary key default uuid_generate_v4(),
  tmdb_id               integer not null unique,
  title                 text not null,
  type                  text not null check (type in ('movie', 'series')),
  release_year          integer,
  description           text,

  -- Classification
  genres                text[] not null default '{}',
  mood_tags             text[] not null default '{}',   -- e.g. "dark-comedy", "slow-burn"
  theme_tags            text[] not null default '{}',   -- e.g. "heist", "workplace"

  -- People
  cast_names            text[] not null default '{}',   -- top 5 cast members
  director_names        text[] not null default '{}',

  -- Runtime
  runtime_minutes       integer,                        -- movies
  avg_episode_minutes   integer,                        -- series
  season_count          integer,                        -- series

  -- Ratings
  imdb_rating           numeric(3,1),
  tmdb_rating           numeric(3,1),
  tmdb_vote_count       integer,

  -- Assets
  poster_url            text,
  backdrop_url          text,
  trailer_url           text,

  -- Locale
  original_language     text,
  content_rating        text,                           -- "PG-13", "TV-MA", etc.

  -- Embedding (voyage-3-lite: 512 dimensions)
  embedding             vector(512),
  embedding_input       text,                           -- exact string that was embedded (auditable)

  -- Raw data for debugging
  tmdb_keywords         text[] not null default '{}',
  metadata              jsonb not null default '{}',    -- raw API responses

  -- Sync tracking
  tmdb_synced_at        timestamptz,
  embedding_synced_at   timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- HNSW index for fast approximate nearest-neighbor search on embeddings
-- ef_construction=64 is a good balance of build speed vs. search quality at our scale
create index if not exists content_embedding_idx
  on content using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Indexes for common filter queries
create index if not exists content_type_idx on content (type);
create index if not exists content_genres_idx on content using gin (genres);
create index if not exists content_mood_tags_idx on content using gin (mood_tags);
create index if not exists content_release_year_idx on content (release_year);

-- ─── Platform Availability ────────────────────────────────────────────────────

create table if not exists content_platforms (
  id               uuid primary key default uuid_generate_v4(),
  content_id       uuid not null references content (id) on delete cascade,
  platform_id      uuid not null references platforms (id),
  region           text not null default 'us',
  available_from   timestamptz,
  available_until  timestamptz,
  deep_link        text,                               -- direct link to watch
  streaming_type   text check (streaming_type in ('subscription', 'rent', 'buy', 'free')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (content_id, platform_id, region)
);

create index if not exists content_platforms_content_idx on content_platforms (content_id);
create index if not exists content_platforms_platform_region_idx on content_platforms (platform_id, region);
-- Partial index for active availability lookups (our most common query)
create index if not exists content_platforms_active_idx
  on content_platforms (platform_id, region)
  where (available_until is null or available_until > now());

-- ─── User Profiles ────────────────────────────────────────────────────────────
-- Extends Supabase auth.users — id mirrors auth.users.id

create table if not exists user_profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  display_name          text,
  region                text not null default 'us',
  preferred_platforms   text[] not null default '{}',  -- ["netflix", "prime"]
  onboarding_completed  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into user_profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ─── User Taste Seeds ─────────────────────────────────────────────────────────

create table if not exists user_taste_seeds (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references user_profiles (id) on delete cascade,
  content_id  uuid not null references content (id) on delete cascade,
  sentiment   text not null check (sentiment in ('loved', 'liked', 'disliked')),
  created_at  timestamptz not null default now(),

  unique (user_id, content_id)
);

create index if not exists taste_seeds_user_idx on user_taste_seeds (user_id);

-- ─── Recommendation Sessions ──────────────────────────────────────────────────

create table if not exists recommendation_sessions (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references user_profiles (id) on delete set null,
  query_text        text,                               -- raw NL input
  parsed_intent     jsonb not null default '{}',        -- ParsedIntent struct
  platform_filters  text[] not null default '{}',
  content_type      text check (content_type in ('movie', 'series', 'any')),
  result_count      integer,
  created_at        timestamptz not null default now()
);

create index if not exists rec_sessions_user_idx on recommendation_sessions (user_id, created_at desc);

-- ─── Recommendation Results ───────────────────────────────────────────────────

create table if not exists recommendations (
  id                    uuid primary key default uuid_generate_v4(),
  session_id            uuid not null references recommendation_sessions (id) on delete cascade,
  content_id            uuid not null references content (id) on delete cascade,
  rank                  integer not null,
  score                 numeric(5,4) not null,
  score_breakdown       jsonb not null default '{}',    -- {vector_sim, genre_match, ...}
  explanation           text,                           -- LLM-generated "why this"
  explanation_factors   jsonb not null default '{}',    -- structured explanation inputs
  intent_hash           text,                           -- for explanation cache lookup
  created_at            timestamptz not null default now()
);

create index if not exists recommendations_session_idx on recommendations (session_id, rank);
-- Used for explanation caching: find existing explanation for same content + intent
create index if not exists recommendations_cache_idx on recommendations (content_id, intent_hash)
  where explanation is not null;

-- ─── User Feedback ────────────────────────────────────────────────────────────

create table if not exists recommendation_feedback (
  id                   uuid primary key default uuid_generate_v4(),
  recommendation_id    uuid not null references recommendations (id) on delete cascade,
  user_id              uuid not null references user_profiles (id) on delete cascade,
  sentiment            text not null check (sentiment in (
                         'loved', 'liked', 'disliked', 'not_interested', 'already_seen'
                       )),
  created_at           timestamptz not null default now(),

  unique (recommendation_id, user_id)
);

create index if not exists feedback_user_idx on recommendation_feedback (user_id, created_at desc);
create index if not exists feedback_content_idx
  on recommendation_feedback (user_id)
  include (sentiment);

-- ─── Sync Job Tracking ────────────────────────────────────────────────────────

create table if not exists sync_jobs (
  id                  uuid primary key default uuid_generate_v4(),
  job_type            text not null,   -- 'streaming_catalog', 'tmdb_enrich', 'embeddings'
  status              text not null check (status in ('pending', 'running', 'completed', 'failed')),
  started_at          timestamptz,
  completed_at        timestamptz,
  records_processed   integer,
  error_message       text,
  metadata            jsonb not null default '{}',
  created_at          timestamptz not null default now()
);

create index if not exists sync_jobs_type_status_idx on sync_jobs (job_type, status, created_at desc);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Content and platforms are public reads. User data is private.

alter table content enable row level security;
alter table content_platforms enable row level security;
alter table platforms enable row level security;
alter table user_profiles enable row level security;
alter table user_taste_seeds enable row level security;
alter table recommendation_sessions enable row level security;
alter table recommendations enable row level security;
alter table recommendation_feedback enable row level security;
alter table sync_jobs enable row level security;

-- Public read access for catalog data (content is not user-specific)
create policy "Content is publicly readable"
  on content for select using (true);

create policy "Content platforms are publicly readable"
  on content_platforms for select using (true);

create policy "Platforms are publicly readable"
  on platforms for select using (true);

-- User profiles: users can only see and edit their own profile
create policy "Users can view own profile"
  on user_profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on user_profiles for update using (auth.uid() = id);

-- Taste seeds: private to each user
create policy "Users can manage own taste seeds"
  on user_taste_seeds for all using (auth.uid() = user_id);

-- Recommendation sessions: private to each user
create policy "Users can view own recommendation sessions"
  on recommendation_sessions for select using (auth.uid() = user_id);

create policy "Users can create recommendation sessions"
  on recommendation_sessions for insert with check (auth.uid() = user_id);

-- Recommendations: private to each user (via session)
create policy "Users can view own recommendations"
  on recommendations for select
  using (exists (
    select 1 from recommendation_sessions s
    where s.id = recommendations.session_id and s.user_id = auth.uid()
  ));

-- Feedback: private to each user
create policy "Users can manage own feedback"
  on recommendation_feedback for all using (auth.uid() = user_id);

-- Sync jobs: service role only (no user-facing policy)
-- Inngest/sync functions use the service role key which bypasses RLS

-- ─── Updated_at triggers ──────────────────────────────────────────────────────

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger content_updated_at
  before update on content
  for each row execute procedure update_updated_at();

create trigger content_platforms_updated_at
  before update on content_platforms
  for each row execute procedure update_updated_at();

create trigger user_profiles_updated_at
  before update on user_profiles
  for each row execute procedure update_updated_at();
