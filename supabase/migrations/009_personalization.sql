-- WatchWise — Personalization foundations (category swiping → taste profile)
-- Migration: 009_personalization
--
-- Three concerns, kept strictly separate (per the Principal Engineer review):
--   1. user_taste_seeds  — COLD-START ONLY. The onboarding swipe sentiments that seed ranking. We only
--      ADD a nullable `category` column so a seed remembers which deck it came from. It is NOT extended
--      with runtime "seen" state — that lives in the append-only interactions log below.
--   2. user_content_interactions — APPEND-ONLY behavioural log. Every ongoing signal (seen / dismissed /
--      not-interested / quick sentiment) plus the immutable record of each onboarding swipe. This is the
--      single source for "already seen" stamping AND the substrate for future persona/ML work. Never
--      updated in place — corrections are new rows; the latest row wins at read time.
--   3. user_category_affinity — DERIVED, per-(user,category) taste prior computed from the swipes. Small,
--      queryable, cheap to load once per request. This is the signal the scorer reads.
--
-- Additive only (ADD COLUMN / CREATE TABLE) — no drops, safe to deploy ahead of the code that uses it.

-- ─── 1. Cold-start seeds: remember the deck category ──────────────────────────────
-- UX intent: lets us attribute a seed to "Crime & Thriller" etc. without overloading the table with
-- mutable state. Nullable so existing rows and the current onboarding flow keep working unchanged.
alter table user_taste_seeds
  add column if not exists category text;

-- ─── 2. Append-only interaction log ───────────────────────────────────────────────
-- One row per signal. `action` is a closed vocabulary (check constraint, mirroring the content.type
-- pattern) so the read side can rely on it. `source` records where the signal came from (onboarding vs
-- discovery) and `context` carries small structured extras (e.g. the journeyId / query that produced it)
-- for later analysis — never anything we must mutate.
-- NOTE: gen_random_uuid() (Postgres core) — NOT uuid_generate_v4() (uuid-ossp). The CLI's `db push`
-- runs with a search_path that doesn't resolve the extension schema, so uuid_generate_v4() errors here
-- (42883) even though older hand-applied migrations used it. gen_random_uuid() needs no extension.
create table if not exists user_content_interactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  content_id  uuid not null references content (id) on delete cascade,
  action      text not null check (action in (
                'swipe_liked', 'swipe_disliked', 'swipe_not_seen',  -- onboarding swipe record (immutable)
                'marked_seen', 'dismissed', 'not_interested',       -- ongoing discovery signals
                'loved', 'not_for_me'                               -- optional quick sentiment
              )),
  category    text,                                                 -- swipe deck category, when applicable
  source      text not null default 'discovery',                    -- 'onboarding' | 'discovery'
  context     jsonb not null default '{}',                          -- journeyId / query / etc.
  created_at  timestamptz not null default now()
);

-- "Already seen" / dismissal lookups are always scoped to a user; index for them. The (user, content,
-- created_at desc) shape lets a read take the latest signal per title cheaply.
create index if not exists user_content_interactions_user_idx
  on user_content_interactions (user_id, created_at desc);
create index if not exists user_content_interactions_user_content_idx
  on user_content_interactions (user_id, content_id, created_at desc);

-- ─── 3. Derived per-category taste prior ──────────────────────────────────────────
-- affinity in [0,1], centered at 0.5 (neutral). sample_count = how many swipes backed it (confidence).
-- Recomputed (upserted) whenever onboarding completes; PK makes that a clean idempotent write.
create table if not exists user_category_affinity (
  user_id       uuid not null references auth.users (id) on delete cascade,
  category      text not null,
  affinity      numeric(4,3) not null default 0.500,
  sample_count  integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, category)
);

-- ─── 4. Reserved: per-user taste vector (Phase 2 centroid retrieval / personas) ───
-- Added now (nullable, unused) so the centroid-retrieval and persona work (N15/N13) don't need another
-- user_profiles migration later. Stored as jsonb to stay backend-agnostic until then.
alter table user_profiles
  add column if not exists taste_vector jsonb;

-- ─── Row Level Security ───────────────────────────────────────────────────────────
alter table user_content_interactions enable row level security;
alter table user_category_affinity     enable row level security;

-- Interactions are APPEND-ONLY at the DB layer: users may INSERT and SELECT their own rows, but there is
-- deliberately NO update/delete policy, so the log cannot be rewritten via the API. (Service role bypasses
-- RLS for any maintenance.)
create policy "Users can read own interactions"
  on user_content_interactions for select using (auth.uid() = user_id);
create policy "Users can append own interactions"
  on user_content_interactions for insert with check (auth.uid() = user_id);

-- Affinity is derived state the user owns: read + write own rows. (Writes normally come from the
-- service-role onboarding-complete path, but allowing the user keeps it consistent and RLS-safe.)
create policy "Users can read own category affinity"
  on user_category_affinity for select using (auth.uid() = user_id);
create policy "Users can write own category affinity"
  on user_category_affinity for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
