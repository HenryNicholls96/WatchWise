-- WatchWise — Catalog sources: multi-source content identity + BBC iPlayer platform
-- Migration: 010_catalog_sources
--
-- migration-lint:allow-destructive: this drops NOT NULL on content.tmdb_id. It is a LOOSENING only —
--   no data is dropped or rewritten away — so we can admit catalogue titles that have no TMDb id
--   (e.g. BBC iPlayer originals). tmdb_id REMAINS UNIQUE (nullable, multiple NULLs allowed), so the
--   existing TMDb-first seed pipeline keeps upserting on tmdb_id with no code change. Expand-phase:
--   apply this BEFORE deploying code that depends on it.
--
-- ROLLBACK (down-migration), in order — only fully safe BEFORE any non-TMDb rows exist:
--   delete from content_platforms where content_id in (select id from content where tmdb_id is null);
--   delete from content where tmdb_id is null;                      -- remove iPlayer-only originals
--   drop index if exists content_content_key_key;
--   drop index if exists content_motn_id_idx;
--   alter table content drop constraint if exists content_identity_present;
--   alter table content drop column if exists content_key;
--   alter table content drop column if exists motn_id;
--   alter table content drop column if exists imdb_id;
--   alter table content_platforms drop column if exists last_seen_at;
--   alter table content alter column tmdb_id set not null;          -- ONLY succeeds once null rows are gone
--   delete from platforms where slug = 'iplayer';
-- NOTE: the new columns are ignored by existing code, so a CODE rollback never requires a DB rollback.

-- ─── 1) BBC iPlayer platform ──────────────────────────────────────────────────
-- slug MUST equal the movieofthenight service id ('iplayer') so the catalogue client maps correctly.
insert into platforms (name, slug) values ('BBC iPlayer', 'iplayer')
on conflict (slug) do nothing;

-- ─── 2) Multi-source content identity ─────────────────────────────────────────
alter table content alter column tmdb_id drop not null;
alter table content add column if not exists imdb_id text;
alter table content add column if not exists motn_id text;

-- content_key: stable, derived identity. Prefer the TMDb id (so a title found via BOTH the TMDb-first
-- flow AND a catalogue enumeration collapses to ONE row), else the movieofthenight id. GENERATED +
-- STORED so it is always correct and is auto-computed for every existing row at migration time
-- (each becomes 'tmdb:<id>') — no manual backfill. IMDb id is kept as an enrichment column only,
-- deliberately NOT part of identity, to keep the key stable across enrichment.
alter table content
  add column if not exists content_key text
  generated always as (coalesce('tmdb:' || tmdb_id::text, 'motn:' || motn_id)) stored;

-- Identity guarantee: every row has at least one of (tmdb_id, motn_id), so content_key is never null.
alter table content add constraint content_identity_present
  check (tmdb_id is not null or motn_id is not null);

create unique index if not exists content_content_key_key on content (content_key);
create index if not exists content_motn_id_idx on content (motn_id) where motn_id is not null;

-- ─── 3) Availability freshness / removal detection (daily refresh) ─────────────
-- Each refresh stamps last_seen_at on every (content, platform, region) it re-confirms; a full run can
-- then remove rows for that platform/region not seen this run (titles that left the catalogue).
alter table content_platforms add column if not exists last_seen_at timestamptz;
create index if not exists content_platforms_last_seen_idx
  on content_platforms (platform_id, region, last_seen_at);
