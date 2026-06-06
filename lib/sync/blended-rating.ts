// Blended rating — combines IMDb + Metacritic + TMDb into a single 0–100 "Rating".
//
// Pure and dependency-free so it's trivially unit-testable and re-tunable. Computed in the background
// enrichment step (scripts/blend-ratings.ts), never at query time. Each source is normalized to 0–100
// and combined as a weighted average over the sources actually present, with the weights re-normalized
// so a missing source (common for TV / non-US titles) doesn't deflate the score.

export type BlendSources = {
  /** IMDb rating on a 0–10 scale, with optional vote count. */
  imdb?: { rating: number; votes?: number | null } | null
  /** Metacritic Metascore on a 0–100 scale. */
  metacritic?: number | null
  /** TMDb vote average on a 0–10 scale, with optional vote count. */
  tmdb?: { rating: number; votes?: number | null } | null
}

export type BlendSourceKey = 'imdb' | 'metacritic' | 'tmdb'

export type BlendResult = {
  /** Final blended score 0–100 (one decimal), or null when no source was usable. */
  blendedRating: number | null
  /** Which sources contributed, in weight order. */
  contributing: BlendSourceKey[]
}

// IMDb is the most recognized, so it carries the most weight; Metacritic adds critic credibility;
// TMDb is a supplementary crowd signal. Re-normalized over whatever is present.
export const BLEND_WEIGHTS: Record<BlendSourceKey, number> = {
  imdb: 0.45,
  metacritic: 0.35,
  tmdb: 0.2,
}

function clamp01to100(n: number): number | null {
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

/** Combines available sources into a weighted, re-normalized 0–100 blend. */
export function calculateBlendedRating(sources: BlendSources): BlendResult {
  const parts: { key: BlendSourceKey; value: number; weight: number }[] = []

  if (sources.imdb && Number.isFinite(sources.imdb.rating)) {
    const v = clamp01to100(sources.imdb.rating * 10)
    if (v != null) parts.push({ key: 'imdb', value: v, weight: BLEND_WEIGHTS.imdb })
  }
  if (sources.metacritic != null && Number.isFinite(sources.metacritic)) {
    const v = clamp01to100(sources.metacritic)
    if (v != null) parts.push({ key: 'metacritic', value: v, weight: BLEND_WEIGHTS.metacritic })
  }
  if (sources.tmdb && Number.isFinite(sources.tmdb.rating)) {
    const v = clamp01to100(sources.tmdb.rating * 10)
    if (v != null) parts.push({ key: 'tmdb', value: v, weight: BLEND_WEIGHTS.tmdb })
  }

  if (parts.length === 0) return { blendedRating: null, contributing: [] }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
  const weighted = parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight

  return {
    blendedRating: Math.round(weighted * 10) / 10,
    contributing: parts.map((p) => p.key),
  }
}
