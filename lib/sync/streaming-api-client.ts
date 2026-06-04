// Streaming Availability API client (movieofthenight.com direct).
// Checks whether a given TMDb title is currently streamable on target platforms.
//
// API docs: https://docs.movieofthenight.com
// Auth: x-api-key header (STREAMING_API_KEY env var)
// Rate limiting: p-limit(5) concurrent requests + exponential backoff on 429.
//
// If endpoint paths change (e.g. API version bump), update BASE_PATH only.

import pLimit from 'p-limit'
import type { AvailableCandidate, PlatformAvailability, TMDbCandidate, StreamingType } from '@/lib/types/sync'

// Platforms we care about — slugs must match what the API returns
export const TARGET_PLATFORMS = ['netflix', 'prime', 'disney'] as const
export type TargetPlatform = typeof TARGET_PLATFORMS[number]

// Maximum concurrent requests to the streaming API
const CONCURRENCY = 5

// ─── Internal API Response Types ─────────────────────────────────────────────

type StreamingOption = {
  streamingType: string
  link: string
  quality?: string
  availableSince?: number   // Unix timestamp (seconds)
  leaving?: number          // Unix timestamp (seconds)
}

type StreamingInfoByPlatform = Record<string, StreamingOption[]>
type StreamingInfoByCountry = Record<string, StreamingInfoByPlatform>

type ShowResult = {
  itemType: string
  showType: string
  id: string
  tmdbId?: string
  title: string
  streamingInfo: StreamingInfoByCountry
}

type ShowResponse = {
  result: ShowResult
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Converts a Unix timestamp (seconds) to a Date, or null if undefined. */
function unixToDate(ts: number | undefined): Date | null {
  return ts != null ? new Date(ts * 1000) : null
}

/**
 * Exponential backoff retry. Retries only on 429 (rate limit) or 503 (transient).
 * All other errors (404 = not found, 401 = bad key) are not retried.
 */
async function fetchWithRetry(
  url: string,
  headers: HeadersInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { headers })

    if (response.ok) return response
    if (response.status === 404) return response  // Not found — not an error worth retrying

    if (response.status === 429 || response.status === 503) {
      lastError = new Error(`HTTP ${response.status}`)
      const delayMs = Math.min(1000 * 2 ** attempt, 16_000)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      continue
    }

    // Other errors (401, 500, etc.) — throw immediately
    throw new Error(`Streaming API error ${response.status}: ${await response.text()}`)
  }

  throw lastError ?? new Error('Streaming API request failed after retries')
}

// ─── Client Factory ───────────────────────────────────────────────────────────

export function createStreamingApiClient(apiKey: string, baseUrl: string, country: string) {
  const limit = pLimit(CONCURRENCY)
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' }

  /**
   * Checks streaming availability for a single title by TMDb ID.
   * Returns the candidate with platform data if available, or null if not on any target platform.
   *
   * Endpoint: GET {baseUrl}/shows/{type}/{tmdbId}?country={country}
   *
   * NOTE: If you see unexpected 404s for titles you know are available,
   * verify the endpoint format at https://docs.movieofthenight.com
   * The type segment should be "movie" or "series".
   */
  async function checkOne(candidate: TMDbCandidate): Promise<AvailableCandidate | null> {
    return limit(async () => {
      const type = candidate.type === 'movie' ? 'movie' : 'series'
      const url = `${baseUrl}/shows/${type}/${candidate.tmdbId}?country=${country}`

      let response: Response
      try {
        response = await fetchWithRetry(url, headers)
      } catch (err) {
        // Network error or repeated 429 — treat as API error (caller handles)
        throw err
      }

      if (response.status === 404) return null

      const body = await response.json() as ShowResponse
      const countryInfo = body.result?.streamingInfo?.[country]

      if (!countryInfo) return null

      const platforms: PlatformAvailability[] = []

      for (const slug of TARGET_PLATFORMS) {
        const options = countryInfo[slug]
        if (!options || options.length === 0) continue

        // In MVP, we care about subscription and free content only.
        // Rent/buy requires a separate transaction outside the user's subscription.
        const eligibleOption = options.find(
          o => o.streamingType === 'subscription' || o.streamingType === 'free'
        )

        if (!eligibleOption) continue

        platforms.push({
          platformSlug: slug,
          deepLink: eligibleOption.link,
          streamingType: eligibleOption.streamingType as StreamingType,
          availableFrom: unixToDate(eligibleOption.availableSince),
          availableUntil: unixToDate(eligibleOption.leaving),
        })
      }

      if (platforms.length === 0) return null

      return { ...candidate, platforms }
    })
  }

  return {
    /**
     * Checks streaming availability for a batch of candidates.
     * Runs CONCURRENCY checks in parallel with backoff on rate limits.
     * Returns an object with available titles and an error count for logging.
     */
    async checkBatch(candidates: TMDbCandidate[]): Promise<{
      available: AvailableCandidate[]
      apiErrors: number
    }> {
      let apiErrors = 0
      const results = await Promise.allSettled(candidates.map(c => checkOne(c)))

      const available: AvailableCandidate[] = []
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          available.push(result.value)
        } else if (result.status === 'rejected') {
          apiErrors++
        }
        // fulfilled with null = title exists but not on target platforms — expected, not an error
      }

      return { available, apiErrors }
    },
  }
}
