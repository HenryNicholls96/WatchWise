-- WatchWise — Onboarding preferences
-- Migration: 007_user_preferences
--
-- Adds a free-form preferences bag to user_profiles for onboarding follow-up answers that don't map
-- to an existing column. v1 stores { contentType, avoidGenres, runtime } (see lib/types/onboarding.ts
-- preferencesSchema). Platforms continue to live in the existing preferred_platforms column; swipe
-- likes/dislikes live in user_taste_seeds. Kept as jsonb so we can add preference dimensions without a
-- migration each time.

alter table user_profiles
  add column if not exists preferences jsonb not null default '{}';
