// OMDb API client — fetches IMDb rating/votes and Metacritic Metascore for a title by IMDb id.
// Free tier is 1,000 requests/day; there's no tight per-second limit, but we throttle politely and
// retry transient failures. Style mirrors tmdb-client.ts (axios for Windows stability).
//
// OMDb returns string fields, with "N/A" for missing data — every value is parsed defensively.

import axios from 'axios'

const BASE_URL = 'https://www.omdbapi.com/'
const OMDB_MIN_INTERVAL_MS = 120
const OMDB_MAX_RETRIES = 3

export type OmdbRatings = {
  /** True when OMDb found the title (Response: "True"). */
  found: boolean
  /** IMDb rating on a 0–10 scale, or null. */
  imdbRating: number | null
  /** IMDb vote count, or null. */
  imdbVotes: number | null
  /** Metacritic Metascore on a 0–100 scale, or null. */
  metascore: number | null
}

type OmdbResponse = {
  Response: string
  Error?: string
  imdbRating?: string
  imdbVotes?: string
  Metascore?: string
}

function parseNa(value: string | undefined): string | null {
  if (!value || value === 'N/A') return null
  return value
}

function parseNumber(value: string | undefined): number | null {
  const raw = parseNa(value)
  if (raw == null) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

const omdbAxios = axios.create({ baseURL: BASE_URL, timeout: 15_000 })
let _lastRequest = 0

async function throttledGet(url: string): Promise<OmdbResponse> {
  const wait = OMDB_MIN_INTERVAL_MS - (Date.now() - _lastRequest)
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  _lastRequest = Date.now()

  let lastErr: unknown
  for (let attempt = 0; attempt <= OMDB_MAX_RETRIES; attempt++) {
    try {
      const { data } = await omdbAxios.get<OmdbResponse>(url)
      return data
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw lastErr
}

export function createOmdbClient(apiKey: string) {
  return {
    /** Fetches ratings for a title by IMDb id (e.g. "tt0903747"). Never throws for "not found". */
    async getByImdbId(imdbId: string): Promise<OmdbRatings> {
      const url = `${BASE_URL}?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`
      const data = await throttledGet(url)
      if (data.Response !== 'True') {
        return { found: false, imdbRating: null, imdbVotes: null, metascore: null }
      }
      const imdbRating = parseNumber(data.imdbRating)
      return {
        found: true,
        imdbRating: imdbRating != null && imdbRating >= 0 && imdbRating <= 10 ? imdbRating : null,
        imdbVotes: parseNumber(data.imdbVotes),
        metascore: parseNumber(data.Metascore),
      }
    },
  }
}
