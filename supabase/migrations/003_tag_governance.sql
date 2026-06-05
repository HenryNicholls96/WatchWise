-- WatchWise — Tag Governance & Re-embedding Support
-- Migration: 003_tag_governance
--
-- Adds two capabilities:
--   1. tag_change_log — an append-only audit trail of every tag_mappings change,
--      so tag evolution is versioned and reversible.
--   2. content.embedded_input_hash — lets the embedding step detect exactly which
--      titles need re-embedding after their embedding_input changes (e.g. new tags),
--      instead of blindly re-embedding the whole catalog.

-- ─── Tag Change Log ───────────────────────────────────────────────────────────
-- One row per logical batch of tag changes. Keep `applied_by` = your name/initials.
-- Query history with:  select * from tag_change_log order by applied_at desc;

create table if not exists tag_change_log (
  id            uuid primary key default uuid_generate_v4(),
  change_type   text not null check (change_type in ('add', 'remove', 'remap', 'reject')),
  tag_type      text check (tag_type in ('mood', 'theme')),
  tag_value     text,
  keywords      text[] not null default '{}',     -- keywords affected by this change
  rationale     text not null,                    -- WHY — required, no silent changes
  validated     boolean not null default false,   -- did we run validate-tag-impact.ts first?
  titles_affected integer,                         -- impact count from the dry-run
  applied_by    text,
  applied_at    timestamptz not null default now()
);

create index if not exists tag_change_log_applied_at_idx on tag_change_log (applied_at desc);

alter table tag_change_log enable row level security;
create policy "Tag change log is publicly readable"
  on tag_change_log for select using (true);

-- ─── Re-embedding Detection ───────────────────────────────────────────────────
-- embedded_input_hash stores the md5 of the embedding_input that was ACTUALLY
-- embedded. The embedding step re-embeds any row where:
--     embedding IS NULL
--  OR embedded_input_hash IS DISTINCT FROM md5(embedding_input)
-- This makes re-embedding precise and self-healing: only drifted titles are touched.

alter table content
  add column if not exists embedded_input_hash text;

-- Fast lookup of titles needing (re-)embedding.
create index if not exists content_needs_embedding_idx
  on content (id)
  where embedding is null or embedded_input_hash is null;
