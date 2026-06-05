// Streaming Availability API client (movieofthenight.com direct).
// Checks whether a given TMDb title is currently streamable on target platforms.
//
// API docs: https://docs.movieofthenight.com
// Auth: x-api-key header (STREAMING_API_KEY env var)
// Rate limiting: p-limit(5) concurrent requests + exponential backoff on 429.
//
// If endpoint paths change (e.g. API version bump), update BASE_PATH only.

import axios from 'axios'
import pLimit from 'p-limit'
import type { AvailableCandidate, PlatformAvailability, TMDbCandidate, StreamingType } from '@/lib/types/sync'

// Platforms we care about — slugs must match what the API returns
export const TARGET_PLATFORMS = ['netflix', 'prime', 'disney'] as const
export type TargetPlatform = typeof TARGET_PLATFORMS[number]

// Concurrency for streaming availability checks.
// Free API key has rate limits — run seed script on separate days to accumulate more titles.
const CONCURRENCY = 5

// ─── Internal API Response Types (v4 format) ─────────────────────────────────
// v4 returns the show data at the top level (no `result` wrapper).
// streamingOptions is a flat array per country — each item has service.id for platform.

type StreamingOptionV4 = {
  service: { id: string }
  type: string                  // "subscription" | "rent" | "buy" | "addon" | "free"
  link: string
  expiresSoon?: boolean
  availableSince?: number       // Unix timestamp (seconds)
  price?: { amount: string; currency: string }
}

type ShowResponseV4 = {
  itemType: string
  showType: string
  id: string
  tmdbId?: string
  title: string
  streamingOptions?: Record<string, StreamingOptionV4[]>  // keyed by country code
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Converts a Unix timestamp (seconds) to a Date, or null if undefined. */
function unixToDate(ts: number | undefined): Date | null {
  return ts != null ? new Date(ts * 1000) : null
}

/**
 * Axios instance for the Streaming API.
 * Uses Node's built-in https module (more reliable than undici/fetch on Windows).
 * validateStatus: null means axios won't throw on non-2xx — we handle status ourselves.
 */
const streamingAxios = axios.create({
  timeout: 15_000,
  validateStatus: () => true, // never throw on HTTP error codes — we check status ourselves
})

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
      // The motn API uses TMDb's URL convention — 'movie' and 'tv' (NOT 'series').
      // Our internal type is 'movie' | 'series', so map 'series' → 'tv' for the path.
      // Getting this wrong makes every series 404 and get silently dropped as "unavailable".
      const apiType = candidate.type === 'movie' ? 'movie' : 'tv'
      // v4 endpoint: /v4/shows/{movie|tv}/{tmdbId}?country={country}
      const url = `${baseUrl}/v4/shows/${apiType}/${candidate.tmdbId}?country=${country}`

      let response: Awaited<ReturnType<typeof streamingAxios.get<ShowResponseV4>>>

      let lastErr: unknown
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          response = await streamingAxios.get<ShowResponseV4>(url, { headers })
          break
        } catch (err) {
          lastErr = err
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
      if (!response!) throw lastErr

      if (response.status === 404) return null
      if (response.status === 429 || response.status === 503) throw new Error(`HTTP ${response.status}`)
      if (response.status === 401 || response.status === 403) throw new Error(`Streaming API auth failed (${response.status})`)

      // v4: streamingOptions[country] is a flat array of options with service.id
      const countryOptions = response.data?.streamingOptions?.[country]

      if (!countryOptions || countryOptions.length === 0) return null

      const platforms: PlatformAvailability[] = []
      const seenPlatforms = new Set<string>()

      for (const option of countryOptions) {
        const slug = option.service.id
        if (!TARGET_PLATFORMS.includes(slug as TargetPlatform)) continue
        if (seenPlatforms.has(slug)) continue  // keep first eligible option per platform

        // In MVP: subscription and free only — rent/buy requires a separate transaction
        if (option.type !== 'subscription' && option.type !== 'free') continue

        seenPlatforms.add(slug)
        platforms.push({
          platformSlug: slug,
          deepLink: option.link,
          streamingType: option.type as StreamingType,
          availableFrom: unixToDate(option.availableSince),
          availableUntil: null,  // v4 uses expiresSoon boolean, not a specific date
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
