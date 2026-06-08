// Catalog ingestion domain types + Zod boundary schemas for the movieofthenight catalogue feed.
// Zod is the source of truth at the API boundary: a malformed item is logged + skipped, never written.

import { z } from 'zod'
import type { ContentType, StreamingType } from '@/lib/types/sync'

// ─── movieofthenight Show (validated subset) ──────────────────────────────────
// Shapes confirmed against the live /v4/shows/search/filters response.

const motnGenre = z.object({ id: z.string(), name: z.string() })
const imageVariant = z.record(z.string(), z.string())

export const motnStreamingOptionSchema = z.object({
  service: z.object({ id: z.string() }),
  type: z.string(),
  link: z.string().optional(),
  expiresSoon: z.boolean().optional(),
  availableSince: z.number().optional(),
})
export type MotnStreamingOption = z.infer<typeof motnStreamingOptionSchema>

export const motnShowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    showType: z.enum(['movie', 'series']),
    title: z.string().min(1),
    overview: z.string().optional(),
    releaseYear: z.number().int().optional(),
    firstAirYear: z.number().int().optional(),
    imdbId: z.string().optional(),
    tmdbId: z.string().optional(), // "movie/872790" | "tv/136369"
    genres: z.array(motnGenre).optional(),
    cast: z.array(z.string()).optional(),
    directors: z.array(z.string()).optional(),
    creators: z.array(z.string()).optional(),
    rating: z.number().optional(), // motn aggregate 0–100
    runtime: z.number().int().optional(),
    seasonCount: z.number().int().optional(),
    imageSet: z
      .object({
        verticalPoster: imageVariant.optional(),
        horizontalBackdrop: imageVariant.optional(),
      })
      .partial()
      .optional(),
    streamingOptions: z.record(z.string(), z.array(motnStreamingOptionSchema)).optional(),
  })
  .passthrough()
export type MotnShow = z.infer<typeof motnShowSchema>

/** A page of the catalogue enumeration. */
export const catalogPageSchema = z.object({
  shows: z.array(z.unknown()),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
})
export type CatalogPage = { shows: MotnShow[]; hasMore: boolean; nextCursor: string | null }

// ─── Normalized title (pipeline-internal) ─────────────────────────────────────

export type CatalogAvailability = {
  platformSlug: string
  region: string
  deepLink: string | null
  streamingType: StreamingType
  availableFrom: Date | null
  availableUntil: Date | null
}

export type IngestedTitle = {
  /** Derived identity: 'tmdb:<id>' when a tmdbId exists, else 'motn:<id>'. */
  contentKey: string
  motnId: string
  tmdbId: number | null
  imdbId: string | null
  type: ContentType
  title: string
  releaseYear: number | null
  description: string | null
  genres: string[]
  castNames: string[]
  directorNames: string[]
  runtimeMinutes: number | null
  seasonCount: number | null
  posterUrl: string | null
  backdropUrl: string | null
  /** motn aggregate rating (0–100), kept as a weak fallback signal. */
  motnRating: number | null
  availability: CatalogAvailability[]
}

/** Per-title quality-gate / skip reasons (extends the seed pipeline's vocabulary). */
export type CatalogSkipReason =
  | 'validation_failed'
  | 'no_active_availability'
  | 'missing_poster'
  | 'missing_description'
  | 'no_genres'

// ─── Audit ────────────────────────────────────────────────────────────────────

export type AuditVerdict = 'pass' | 'needs_review' | 'fail'

export type AuditLayerResult = {
  checked: number
  passed: number
  /** pass-rate in [0,1]; null when nothing was checkable. */
  rate: number | null
  /** ids/titles that failed this layer (for the human report). */
  failures: string[]
}

export type AuditReport = {
  verdict: AuditVerdict
  internalConsistency: AuditLayerResult
  deepLinkLiveness: AuditLayerResult
  crossSource: AuditLayerResult
  /** When true (broadcaster platforms), cross-source is quarantine-only and excluded from the verdict. */
  crossSourceSoft: boolean
  sampleSize: number
  thresholds: AuditThresholds
  ranAt: string
}

export type AuditThresholds = {
  /** ≥ pass → pass band; between fail and pass → needs_review; < fail → hard fail. */
  internalConsistency: { pass: number; fail: number }
  deepLinkLiveness: { pass: number; fail: number }
  /** disagreement bands (lower is better): ≤ pass ok; between → review; > fail → hard fail. */
  crossSourceDisagreement: { pass: number; fail: number }
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  internalConsistency: { pass: 0.99, fail: 0.9 },
  deepLinkLiveness: { pass: 0.98, fail: 0.9 },
  crossSourceDisagreement: { pass: 0.05, fail: 0.15 },
}

export type IngestMode = 'subset' | 'expand' | 'refresh'

export type IngestResult = {
  jobId: string | null
  verdict: AuditVerdict
  enumerated: number
  written: number
  skipped: Partial<Record<CatalogSkipReason, number>>
  removed: number
  audit: AuditReport | null
}
