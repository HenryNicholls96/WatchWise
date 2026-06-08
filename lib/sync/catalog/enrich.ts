// Enrichment — best-effort, fail-open. The motn feed already provides rich primary metadata (title,
// genres incl. Documentary, synopsis, cast, poster, runtime). This layer adds:
//   • a blended 0–100 rating from OMDb (IMDb + Metacritic), when an imdbId exists;
//   • mood/theme tags via the shared tag mapper (genre-level for now — keyword-level enrichment that
//     requires a TMDb detail fetch is a documented follow-up);
//   • the auditable embedding_input string.
// Any failure falls back to motn-only metadata, so BBC originals without external ids still ingest well.

import type { OmdbRatings } from '@/lib/sync/omdb-client'
import { calculateBlendedRating } from '@/lib/sync/blended-rating'
import { applyTagMappings } from '@/lib/sync/keyword-mapper'
import { type Logger, noopLogger } from '@/lib/types/logger'
import type { TagMapping } from '@/lib/types/sync'
import type { IngestedTitle } from '@/lib/sync/catalog/types'

export type EnrichedTitle = {
  moodTags: string[]
  themeTags: string[]
  blendedRating: number | null
  ratingSources: Record<string, unknown> | null
  embeddingInput: string
}

export type EnrichDeps = {
  /** OMDb lookup by IMDb id (best-effort). Omit to skip rating enrichment. */
  getOmdb?: (imdbId: string) => Promise<OmdbRatings>
  tagMappings: TagMapping[]
  logger?: Logger
}

function buildEmbeddingInput(t: IngestedTitle, moodTags: string[], themeTags: string[]): string {
  const parts = [
    `Title: ${t.title}.`,
    `Type: ${t.type}.`,
    t.releaseYear ? `Year: ${t.releaseYear}.` : '',
    t.genres.length ? `Genres: ${t.genres.slice(0, 4).join(', ')}.` : '',
    moodTags.length ? `Mood: ${moodTags.slice(0, 4).join(', ')}.` : '',
    themeTags.length ? `Themes: ${themeTags.slice(0, 4).join(', ')}.` : '',
    t.description ? `Description: ${t.description.slice(0, 400).replace(/\s+/g, ' ').trim()}.` : '',
    t.castNames.length ? `Cast: ${t.castNames.slice(0, 5).join(', ')}.` : '',
  ]
  return parts.filter(Boolean).join(' ')
}

export async function enrichTitle(title: IngestedTitle, deps: EnrichDeps): Promise<EnrichedTitle> {
  const logger = deps.logger ?? noopLogger

  const { moodTags, themeTags } = applyTagMappings([], title.genres, deps.tagMappings)

  let blendedRating: number | null = null
  let ratingSources: Record<string, unknown> | null = null
  if (title.imdbId && deps.getOmdb) {
    try {
      const omdb = await deps.getOmdb(title.imdbId)
      if (omdb.found) {
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
    } catch (err) {
      logger.warn('catalog enrich: OMDb lookup failed (non-fatal)', {
        imdbId: title.imdbId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    moodTags,
    themeTags,
    blendedRating,
    ratingSources,
    embeddingInput: buildEmbeddingInput(title, moodTags, themeTags),
  }
}
