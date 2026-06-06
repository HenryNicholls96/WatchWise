// Client-side fetch wrapper for POST /api/recommendations.
// Reuses the engine's Recommendation type (type-only import, erased at build) so the UI contract
// can never drift from what the pipeline actually returns.

import type { AppliedConstraints, Recommendation } from '@/lib/recommendations/engine'

export type { AppliedConstraints, Recommendation }

export type RecommendationsRequest = {
  query: string
  platformSlugs?: string[]
  contentType?: 'movie' | 'series'
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
 * query + limit — NO client ranking data; the server re-runs its own authoritative pipeline. Returns a
 * map of contentId → explanation. Used as a background prefetch after the grid renders.
 */
export async function fetchExplanations(
  query: string,
  limit?: number,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const res = await fetch('/api/recommendations/explanations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(limit ? { query, limit } : { query }),
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
