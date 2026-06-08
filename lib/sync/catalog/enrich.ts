// Enrichment — best-effort, fail-open. The motn feed already provides rich primary metadata. This layer:
//   • DESCRIPTION BACKFILL: when motn has no synopsis, fill it from TMDb (by tmdbId) then OMDb Plot (by
//     imdbId), so titles aren't needlessly skipped for missing_description. The source is reported so we
//     can log enrichment usage (and how many titles were rescued).
//   • a blended 0–100 rating from OMDb (IMDb + Metacritic), when an imdbId exists;
//   • mood/theme tags via the shared tag mapper (genre-level for now; keyword-level is a follow-up);
//   • the auditable embedding_input string (built from the RESOLVED description).
// A single OMDb call yields both ratings and plot. TMDb is only hit when the description is missing.

import type { OmdbRatings } from '@/lib/sync/omdb-client'
import { calculateBlendedRating } from '@/lib/sync/blended-rating'
import { applyTagMappings } from '@/lib/sync/keyword-mapper'
import { type Logger, noopLogger } from '@/lib/types/logger'
import type { ContentType, TagMapping } from '@/lib/types/sync'
import type { IngestedTitle } from '@/lib/sync/catalog/types'

/** Where a title's final description came from. 'none' = still missing after backfill (→ will be skipped). */
export type DescriptionSource = 'motn' | 'tmdb' | 'omdb' | 'none'

export type EnrichedTitle = {
  /** Resolved description (motn original, or backfilled). Null only when no source had one. */
  description: string | null
  descriptionSource: DescriptionSource
  moodTags: string[]
  themeTags: string[]
  blendedRating: number | null
  ratingSources: Record<string, unknown> | null
  embeddingInput: string
}

export type EnrichDeps = {
  /** OMDb lookup by IMDb id (ratings + plot), best-effort. */
  getOmdb?: (imdbId: string) => Promise<OmdbRatings>
  /** TMDb synopsis lookup by tmdbId, used to backfill a missing description. */
  getTmdbOverview?: (tmdbId: number, type: ContentType) => Promise<string | null>
  tagMappings: TagMapping[]
  logger?: Logger
}

function buildEmbeddingInput(t: IngestedTitle, description: string | null, moodTags: string[], themeTags: string[]): string {
  const parts = [
    `Title: ${t.title}.`,
    `Type: ${t.type}.`,
    t.releaseYear ? `Year: ${t.releaseYear}.` : '',
    t.genres.length ? `Genres: ${t.genres.slice(0, 4).join(', ')}.` : '',
    moodTags.length ? `Mood: ${moodTags.slice(0, 4).join(', ')}.` : '',
    themeTags.length ? `Themes: ${themeTags.slice(0, 4).join(', ')}.` : '',
    description ? `Description: ${description.slice(0, 400).replace(/\s+/g, ' ').trim()}.` : '',
    t.castNames.length ? `Cast: ${t.castNames.slice(0, 5).join(', ')}.` : '',
  ]
  return parts.filter(Boolean).join(' ')
}

export async function enrichTitle(title: IngestedTitle, deps: EnrichDeps): Promise<EnrichedTitle> {
  const logger = deps.logger ?? noopLogger

  const { moodTags, themeTags } = applyTagMappings([], title.genres, deps.tagMappings)

  // One OMDb call (ratings + plot) when we have an imdbId.
  let omdb: OmdbRatings | null = null
  if (title.imdbId && deps.getOmdb) {
    try {
      omdb = await deps.getOmdb(title.imdbId)
    } catch (err) {
      logger.warn('catalog enrich: OMDb lookup failed (non-fatal)', { imdbId: title.imdbId, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Description precedence: motn → TMDb (only fetched if missing) → OMDb plot.
  let description = title.description
  let descriptionSource: DescriptionSource = description ? 'motn' : 'none'
  if (!description && title.tmdbId != null && deps.getTmdbOverview) {
    try {
      const ov = await deps.getTmdbOverview(title.tmdbId, title.type)
      if (ov) {
        description = ov
        descriptionSource = 'tmdb'
      }
    } catch (err) {
      logger.warn('catalog enrich: TMDb overview failed (non-fatal)', { tmdbId: title.tmdbId, message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!description && omdb?.found && omdb.plot) {
    description = omdb.plot
    descriptionSource = 'omdb'
  }

  // Blended rating from the OMDb call.
  let blendedRating: number | null = null
  let ratingSources: Record<string, unknown> | null = null
  if (omdb?.found) {
    const blend = calculateBlendedRating({
      imdb: omdb.imdbRating != null ? { rating: omdb.imdbRating, votes: omdb.imdbVotes } : null,
      metacritic: omdb.metascore,
    })
    blendedRating = blend.blendedRating
    if (blend.contributing.length > 0) {
      ratingSources = {
        imdb: omdb.imdbRating != null ? { rating: omdb.imdbRating, votes: omdb.imdbVotes } : null,
        metacritic: omdb.metascore,
        contributing: blend.contributing,
      }
    }
  }

  return {
    description,
    descriptionSource,
    moodTags,
    themeTags,
    blendedRating,
    ratingSources,
    embeddingInput: buildEmbeddingInput(title, description, moodTags, themeTags),
  }
}
