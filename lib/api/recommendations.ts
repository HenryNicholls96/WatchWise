// Client-side fetch wrapper for POST /api/recommendations.
// Reuses the engine's Recommendation type (type-only import, erased at build) so the UI contract
// can never drift from what the pipeline actually returns.

import type { AppliedConstraints, Recommendation } from '@/lib/recommendations/engine'

export type { AppliedConstraints, Recommendation }

export type RecommendationsRequest = {
  query: string
  platformSlugs?: string[]
  contentType?: 'movie' | 'series'
  /** Soft genre exclusions to relax (the UI's removable "Excluding: X" chips). Only broadens results. */
  allowGenres?: string[]
  limit?: number
}

export type RecommendationsResponse = {
  count: number
  recommendations: Recommendation[]
  /** Constraints the engine applied (for showing intent chips in the UI). */
  appliedConstraints: AppliedConstraints
}

/** Calls the recommendations endpoint, surfacing the server's friendly error message on failure. */
export async function fetchRecommendations(
  body: RecommendationsRequest,
  signal?: AbortSignal
): Promise<RecommendationsResponse> {
  const res = await fetch('/api/recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data.error)
      .catch(() => undefined)
    throw new Error(message || 'Something went wrong fetching recommendations.')
  }

  return res.json() as Promise<RecommendationsResponse>
}

/**
 * Fetches deferred "why this" explanations (the detail-modal text) for the same search. Sends only the
 * validated search intent (query + limit + any relaxed genre filters) — NO client ranking data; the
 * server re-runs its own authoritative pipeline. allowGenres MUST match what the grid call used, so the
 * re-run produces the same result set. Returns a map of contentId → explanation.
 */
export async function fetchExplanations(
  query: string,
  opts: { limit?: number; allowGenres?: string[] } = {},
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const body: Record<string, unknown> = { query }
  if (opts.limit) body.limit = opts.limit
  if (opts.allowGenres && opts.allowGenres.length > 0) body.allowGenres = opts.allowGenres

  const res = await fetch('/api/recommendations/explanations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data.error)
      .catch(() => undefined)
    throw new Error(message || 'Could not load explanations.')
  }

  const data = (await res.json()) as { explanations: Record<string, string> }
  return data.explanations
}
