// Write layer — deterministic manual upsert keyed by the (generated) content_key.
//
// We intentionally do NOT rely on PostgREST targeting the generated content_key column as an
// on_conflict arbiter (version-sensitive). The ingest is a SINGLE writer (script/cron), so a
// lookup-by-content_key → update-by-id | insert is race-free and gives exact cross-source dedupe:
// a title already present from the TMDb-first flow (content_key 'tmdb:<id>') is UPDATED in place and
// simply gains a new content_platforms row, never duplicated.
//
// content_key itself is never written (it is generated); embeddings are preserved on update.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Logger, noopLogger } from '@/lib/types/logger'
import type { EnrichedTitle } from '@/lib/sync/catalog/enrich'
import type { IngestedTitle } from '@/lib/sync/catalog/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

export async function loadPlatformIdBySlug(supabase: AnyClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('platforms').select('id, slug')
  if (error) throw new Error(`Failed to load platforms: ${error.message}`)
  return new Map((data as { id: string; slug: string }[]).map((p) => [p.slug, p.id]))
}

export type UpsertOutcome = { contentId: string; inserted: boolean }

export async function upsertTitle(
  supabase: AnyClient,
  title: IngestedTitle,
  enriched: EnrichedTitle,
  platformIdBySlug: Map<string, string>,
  runAt: Date,
  deps: { logger?: Logger } = {}
): Promise<UpsertOutcome | null> {
  const logger = deps.logger ?? noopLogger
  const nowIso = runAt.toISOString()

  const contentFields = {
    tmdb_id: title.tmdbId,
    imdb_id: title.imdbId,
    motn_id: title.motnId,
    title: title.title,
    type: title.type,
    release_year: title.releaseYear,
    description: title.description,
    genres: title.genres,
    mood_tags: enriched.moodTags,
    theme_tags: enriched.themeTags,
    cast_names: title.castNames,
    director_names: title.directorNames,
    runtime_minutes: title.runtimeMinutes,
    season_count: title.seasonCount,
    blended_rating: enriched.blendedRating,
    rating_sources: enriched.ratingSources,
    ratings_updated_at: enriched.blendedRating != null ? nowIso : null,
    poster_url: title.posterUrl,
    backdrop_url: title.backdropUrl,
    embedding_input: enriched.embeddingInput,
    metadata: { source: 'motn', motn_id: title.motnId, motn_rating: title.motnRating },
    updated_at: nowIso,
  }

  // 1) Resolve identity by the derived content_key (single-writer → no race).
  const { data: existing, error: selErr } = await supabase
    .from('content')
    .select('id')
    .eq('content_key', title.contentKey)
    .maybeSingle()
  if (selErr) {
    logger.warn('catalog upsert: content lookup failed', { contentKey: title.contentKey, message: selErr.message })
    return null
  }

  let contentId: string
  let inserted: boolean
  if (existing?.id) {
    contentId = existing.id as string
    inserted = false
    const { error } = await supabase.from('content').update(contentFields).eq('id', contentId)
    if (error) {
      logger.warn('catalog upsert: content update failed', { contentKey: title.contentKey, message: error.message })
      return null
    }
  } else {
    const { data, error } = await supabase.from('content').insert(contentFields).select('id').single()
    if (error || !data) {
      logger.warn('catalog upsert: content insert failed', { contentKey: title.contentKey, message: error?.message })
      return null
    }
    contentId = data.id as string
    inserted = true
  }

  // 2) Availability rows (one per platform/region), idempotent on the real unique constraint.
  const platformRows = title.availability
    .map((a) => {
      const platformId = platformIdBySlug.get(a.platformSlug)
      if (!platformId) return null
      return {
        content_id: contentId,
        platform_id: platformId,
        region: a.region,
        deep_link: a.deepLink,
        streaming_type: a.streamingType,
        available_from: a.availableFrom?.toISOString() ?? null,
        available_until: a.availableUntil?.toISOString() ?? null,
        last_seen_at: nowIso,
        updated_at: nowIso,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (platformRows.length > 0) {
    const { error } = await supabase
      .from('content_platforms')
      .upsert(platformRows, { onConflict: 'content_id,platform_id,region', ignoreDuplicates: false })
    if (error) {
      logger.warn('catalog upsert: availability upsert failed', { contentKey: title.contentKey, message: error.message })
    }
  }

  return { contentId, inserted }
}
