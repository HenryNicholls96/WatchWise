// Shared TypeScript types for the content ingestion pipeline.
// Used by lib/sync/ modules and scripts/seed-content.ts.

export type ContentType = 'movie' | 'series'
export type StreamingType = 'subscription' | 'rent' | 'buy' | 'free'
export type TagType = 'mood' | 'theme'

// ─── Tag Mapping ─────────────────────────────────────────────────────────────

export type TagMapping = {
  keyword: string
  tag_type: TagType
  tag_value: string
}

// ─── Pipeline Stages ─────────────────────────────────────────────────────────

/** Raw candidate from TMDb list endpoints (popular, top_rated, discover). */
export type TMDbCandidate = {
  tmdbId: number
  type: ContentType
  title: string
  voteCount: number
  voteAverage: number
  genreIds: number[]
  releaseYear: number | null
  posterPath: string | null
  backdropPath: string | null
  originalLanguage: string
}

/** Platform availability record from the Streaming Availability API. */
export type PlatformAvailability = {
  platformSlug: string
  deepLink: string
  streamingType: StreamingType
  availableFrom: Date | null
  availableUntil: Date | null
}

/** Candidate confirmed as available on at least one target platform. */
export type AvailableCandidate = TMDbCandidate & {
  platforms: PlatformAvailability[]
}

/** Candidate fully enriched with TMDb detail endpoint data. */
export type EnrichedContent = AvailableCandidate & {
  description: string
  genres: string[]
  castNames: string[]
  directorNames: string[]
  runtimeMinutes: number | null
  avgEpisodeMinutes: number | null
  seasonCount: number | null
  tmdbRating: number
  tmdbVoteCount: number
  posterUrl: string | null
  backdropUrl: string | null
  contentRating: string | null
  tmdbKeywords: string[]
}

/** Final pipeline output — enriched content with derived tags and embedding input. */
export type TaggedContent = EnrichedContent & {
  moodTags: string[]
  themeTags: string[]
  embeddingInput: string
  unmappedKeywords: string[]
}

// ─── Sync Job Tracking ───────────────────────────────────────────────────────

export type SkipReason =
  | 'low_vote_count'
  | 'not_available'
  | 'missing_overview'
  | 'api_error'
  | 'enrichment_failed'

export type SkippedTitle = {
  tmdbId: number
  title: string
  reason: SkipReason
  details?: string
}

/** Movie vs series counts — used to make catalog composition visible at each phase. */
export type ByType = { movie: number; series: number }

export type SyncJobMetadata = {
  /** Seed profile used for this run: 'broad' (default) or 'targeted'. */
  seed_mode?: string
  phase_results: {
    fetch_candidates?: {
      raw_fetched: number
      after_dedup: number
      after_vote_filter: number
      by_type: ByType            // candidates entering availability check, split by type
      duration_ms: number
    }
    availability_check?: {
      checked: number
      available: number
      not_available: number
      api_errors: number
      checked_by_type: ByType    // how many of each type were checked
      available_by_type: ByType  // how many of each type passed — the key composition signal
      duration_ms: number
    }
    enrichment?: {
      attempted: number
      succeeded: number
      skipped_missing_overview: number
      skipped_api_error: number
      duration_ms: number
    }
    write?: {
      content_upserted: number
      platforms_upserted: number
      duration_ms: number
    }
  }
  skipped_summary: Partial<Record<SkipReason, number>>
  unmapped_keywords: string[]
  total_duration_ms?: number
}
