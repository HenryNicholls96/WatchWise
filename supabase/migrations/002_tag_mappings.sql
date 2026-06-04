-- WatchWise — Tag Mappings Table
-- Migration: 002_tag_mappings
--
-- Stores keyword → tag mappings used to derive mood_tags and theme_tags
-- from raw TMDb keywords during content ingestion.
--
-- Edit rows directly in Supabase to improve tagging without a code deploy.
-- The seed-content.ts script populates this table on first run.

create table if not exists tag_mappings (
  id          uuid primary key default uuid_generate_v4(),
  keyword     text not null,
  tag_type    text not null check (tag_type in ('mood', 'theme')),
  tag_value   text not null,
  notes       text,                                      -- optional: why this mapping exists
  created_at  timestamptz not null default now(),

  unique (keyword, tag_type)
);

-- Case-insensitive keyword lookup — the ingestion pipeline lowercases all keywords before matching
create index if not exists tag_mappings_keyword_lower_idx on tag_mappings (lower(keyword));
create index if not exists tag_mappings_tag_type_idx on tag_mappings (tag_type);

-- Readable by the rec engine at query time; written only by server-side sync jobs
alter table tag_mappings enable row level security;

create policy "Tag mappings are publicly readable"
  on tag_mappings for select using (true);
