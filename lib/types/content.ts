// Content domain types — the shape of a catalog title as used by the recommendation engine.
//
// contentRowSchema validates rows coming back from the match_content RPC, so any drift
// between the database and these types fails loudly at the boundary rather than silently
// propagating undefined fields into scoring/explanations.

import { z } from 'zod'

export const CONTENT_TYPES = ['movie', 'series'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

/** Per-source inputs behind a title's blended rating (stored in content.rating_sources jsonb). */
export const ratingSourcesSchema = z
  .object({
    imdb: z.object({ rating: z.number(), votes: z.number().nullable() }).nullable().optional(),
    metacritic: z.number().nullable().optional(),
    tmdb: z.object({ rating: z.number(), votes: z.number().nullable() }).nullable().optional(),
    contributing: z.array(z.string()).optional(),
  })
  .passthrough()

export type RatingSources = z.infer<typeof ratingSourcesSchema>

/**
 * A catalog title as returned by vector search. Mirrors the match_content RPC columns.
 * The raw 512-dim embedding is intentionally excluded — it is never needed downstream.
 *
 * Numeric rating columns are coerced because PostgREST may serialize `numeric` as a string;
 * coercion keeps the type honest without trusting the wire format.
 */
export const contentRowSchema = z.object({
  id: z.string().uuid(),
  // Nullable since migration 010: catalogue titles (e.g. BBC iPlayer originals) may have no TMDb id.
  // Carried only — never used for filtering/scoring — so a null here is harmless downstream.
  tmdbId: z.number().int().nullable(),
  title: z.string(),
  type: z.enum(CONTENT_TYPES),
  releaseYear: z.number().int().nullable(),
  description: z.string().nullable(),
  genres: z.array(z.string()),
  moodTags: z.array(z.string()),
  themeTags: z.array(z.string()),
  castNames: z.array(z.string()),
  directorNames: z.array(z.string()),
  runtimeMinutes: z.number().int().nullable(),
  avgEpisodeMinutes: z.number().int().nullable(),
  seasonCount: z.number().int().nullable(),
  imdbRating: z.coerce.number().nullable(),
  tmdbRating: z.coerce.number().nullable(),
  tmdbVoteCount: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  originalLanguage: z.string().nullable(),
  contentRating: z.string().nullable(),
  /** Blended 0–100 "Rating" (IMDb + Metacritic + TMDb). Null until enrichment runs. */
  blendedRating: z.coerce.number().nullable(),
  ratingSources: ratingSourcesSchema.nullable(),
})

export type ContentRow = z.infer<typeof contentRowSchema>

/**
 * Maps a snake_case match_content RPC row to the camelCase ContentRow shape, then validates.
 * Throws ZodError if the row does not match — callers convert this into a typed RetrievalError.
 */
export function parseContentRow(raw: Record<string, unknown>): ContentRow {
  return contentRowSchema.parse({
    id: raw.id,
    tmdbId: raw.tmdb_id,
    title: raw.title,
    type: raw.type,
    releaseYear: raw.release_year,
    description: raw.description,
    genres: raw.genres ?? [],
    moodTags: raw.mood_tags ?? [],
    themeTags: raw.theme_tags ?? [],
    castNames: raw.cast_names ?? [],
    directorNames: raw.director_names ?? [],
    runtimeMinutes: raw.runtime_minutes,
    avgEpisodeMinutes: raw.avg_episode_minutes,
    seasonCount: raw.season_count,
    imdbRating: raw.imdb_rating,
    tmdbRating: raw.tmdb_rating,
    tmdbVoteCount: raw.tmdb_vote_count,
    posterUrl: raw.poster_url,
    backdropUrl: raw.backdrop_url,
    originalLanguage: raw.original_language,
    contentRating: raw.content_rating,
    blendedRating: raw.blended_rating ?? null,
    ratingSources: raw.rating_sources ?? null,
  })
}

/** A retrieval candidate: a title plus its cosine similarity to the query. */
export type Candidate = {
  content: ContentRow
  /** Cosine similarity to the query embedding. ~0.3–0.8 typical for voyage-3-lite text. */
  vectorSimilarity: number
}
