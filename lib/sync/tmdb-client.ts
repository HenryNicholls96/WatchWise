// TMDb API client — fetches candidate lists and full title enrichment data.
// Rate-limited to 40 requests / 10 seconds (TMDb free tier).
//
// To extend: add new list sources by calling fetchList() with additional endpoints.
// To upgrade auth: switch from api_key param to Bearer token (TMDB_API_READ_TOKEN).

import pThrottle from 'p-throttle'
import type { TMDbCandidate, EnrichedContent, AvailableCandidate, ContentType } from '@/lib/types/sync'

const BASE_URL = 'https://api.themoviedb.org/3'
const IMAGE_BASE_W500 = 'https://image.tmdb.org/t/p/w500'
const IMAGE_BASE_W1280 = 'https://image.tmdb.org/t/p/w1280'

// TMDb allows 40 requests per 10 seconds on API key auth
const throttledFetch = pThrottle({ limit: 40, interval: 10_000 })(
  (url: string) => fetch(url)
)

// ─── Internal TMDb Response Types ────────────────────────────────────────────

type TMDbListItem = {
  id: number
  title?: string         // movies
  name?: string          // TV shows
  vote_count: number
  vote_average: number
  overview: string
  poster_path: string | null
  backdrop_path: string | null
  release_date?: string        // movies: "YYYY-MM-DD"
  first_air_date?: string      // TV: "YYYY-MM-DD"
  genre_ids: number[]
  original_language: string
  media_type?: string
}

type TMDbListResponse = {
  page: number
  results: TMDbListItem[]
  total_pages: number
}

type TMDbMovieDetails = {
  id: number
  title: string
  overview: string
  runtime: number | null
  release_date: string
  vote_average: number
  vote_count: number
  poster_path: string | null
  backdrop_path: string | null
  genres: { id: number; name: string }[]
  original_language: string
  keywords: { keywords: { id: number; name: string }[] }
  credits: {
    cast: { name: string; order: number; known_for_department: string }[]
    crew: { name: string; job: string; department: string }[]
  }
  release_dates: {
    results: {
      iso_3166_1: string
      release_dates: { certification: string; type: number }[]
    }[]
  }
}

type TMDbTVDetails = {
  id: number
  name: string
  overview: string
  episode_run_time: number[]
  number_of_seasons: number
  first_air_date: string
  vote_average: number
  vote_count: number
  poster_path: string | null
  backdrop_path: string | null
  genres: { id: number; name: string }[]
  original_language: string
  keywords: { results: { id: number; name: string }[] }
  credits: {
    cast: { name: string; order: number; known_for_department: string }[]
    crew: { name: string; job: string; department: string }[]
  }
  content_ratings: {
    results: { iso_3166_1: string; rating: string }[]
  }
}

// ─── Client Factory ───────────────────────────────────────────────────────────

export function createTMDbClient(apiKey: string) {
  function buildUrl(path: string, params: Record<string, string | number> = {}): string {
    const url = new URL(`${BASE_URL}${path}`)
    url.searchParams.set('api_key', apiKey)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = buildUrl(path, params)
    const response = await throttledFetch(url)

    if (!response.ok) {
      // TMDb returns 429 when rate limited — p-throttle should prevent this
      // but we throw a clear error if it happens anyway
      throw new Error(`TMDb API error ${response.status} for ${path}: ${await response.text()}`)
    }

    return response.json() as Promise<T>
  }

  function extractReleaseYear(item: TMDbListItem): number | null {
    const dateStr = item.release_date ?? item.first_air_date ?? ''
    const year = parseInt(dateStr.slice(0, 4), 10)
    return isNaN(year) ? null : year
  }

  function mapListItem(item: TMDbListItem, type: ContentType): TMDbCandidate {
    return {
      tmdbId: item.id,
      type,
      title: (item.title ?? item.name ?? '').trim(),
      voteCount: item.vote_count,
      voteAverage: item.vote_average,
      genreIds: item.genre_ids,
      releaseYear: extractReleaseYear(item),
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      originalLanguage: item.original_language,
    }
  }

  // ─── List Fetching ──────────────────────────────────────────────────────────

  /** Fetches a single page from any TMDb list endpoint. */
  async function fetchListPage(path: string, type: ContentType, page: number, extraParams: Record<string, string | number> = {}): Promise<TMDbCandidate[]> {
    const data = await get<TMDbListResponse>(path, { page, ...extraParams })
    return data.results.map(item => mapListItem(item, type))
  }

  /** Fetches multiple pages from a TMDb list endpoint and returns all results. */
  async function fetchList(path: string, type: ContentType, pages: number, extraParams: Record<string, string | number> = {}): Promise<TMDbCandidate[]> {
    const results: TMDbCandidate[] = []
    for (let page = 1; page <= pages; page++) {
      const items = await fetchListPage(path, type, page, extraParams)
      results.push(...items)
    }
    return results
  }

  return {
    /**
     * Fetches popular movies (pages 1–n).
     * Source: /movie/popular
     */
    async getPopularMovies(pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/movie/popular', 'movie', pages)
    },

    /**
     * Fetches top-rated movies (pages 1–n).
     * Source: /movie/top_rated
     */
    async getTopRatedMovies(pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/movie/top_rated', 'movie', pages)
    },

    /**
     * Fetches popular TV series (pages 1–n).
     * Source: /tv/popular
     */
    async getPopularTV(pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/tv/popular', 'series', pages)
    },

    /**
     * Fetches top-rated TV series (pages 1–n).
     * Source: /tv/top_rated
     */
    async getTopRatedTV(pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/tv/top_rated', 'series', pages)
    },

    /**
     * Fetches movies for a specific genre via the Discover endpoint.
     * Used to add genre diversity beyond popular/top_rated lists.
     * @param genreId - TMDb genre ID (e.g. 35 = Comedy, 878 = Science Fiction)
     */
    async discoverMoviesByGenre(genreId: number, pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/discover/movie', 'movie', pages, {
        with_genres: genreId,
        sort_by: 'vote_average.desc',
        'vote_count.gte': 150,
      })
    },

    /**
     * Fetches TV series for a specific genre via the Discover endpoint.
     * @param genreId - TMDb genre ID (e.g. 35 = Comedy, 10765 = Sci-Fi & Fantasy)
     */
    async discoverTVByGenre(genreId: number, pages: number): Promise<TMDbCandidate[]> {
      return fetchList('/discover/tv', 'series', pages, {
        with_genres: genreId,
        sort_by: 'vote_average.desc',
        'vote_count.gte': 150,
      })
    },

    /**
     * Fetches full movie details including keywords and credits.
     * Returns null if the title cannot be enriched (missing overview, API error, etc.)
     */
    async enrichMovie(candidate: AvailableCandidate): Promise<EnrichedContent | null> {
      try {
        const data = await get<TMDbMovieDetails>(`/movie/${candidate.tmdbId}`, {
          append_to_response: 'keywords,credits,release_dates',
        })

        if (!data.overview?.trim()) return null

        const castNames = data.credits.cast
          .filter(c => c.known_for_department === 'Acting')
          .sort((a, b) => a.order - b.order)
          .slice(0, 5)
          .map(c => c.name)

        const directorNames = data.credits.crew
          .filter(c => c.job === 'Director')
          .map(c => c.name)

        // US content rating: type 3 = Theatrical (most common for certifications)
        const usRatingEntry = data.release_dates.results.find(r => r.iso_3166_1 === 'US')
        const contentRating = usRatingEntry?.release_dates.find(d => d.certification)?.certification ?? null

        return {
          ...candidate,
          description: data.overview.trim(),
          genres: data.genres.map(g => g.name),
          castNames,
          directorNames,
          runtimeMinutes: data.runtime ?? null,
          avgEpisodeMinutes: null,
          seasonCount: null,
          tmdbRating: data.vote_average,
          tmdbVoteCount: data.vote_count,
          posterUrl: data.poster_path ? `${IMAGE_BASE_W500}${data.poster_path}` : null,
          backdropUrl: data.backdrop_path ? `${IMAGE_BASE_W1280}${data.backdrop_path}` : null,
          contentRating,
          tmdbKeywords: data.keywords.keywords.map(k => k.name.toLowerCase().trim()),
        }
      } catch {
        return null
      }
    },

    /**
     * Fetches full TV series details including keywords and credits.
     * Returns null if the title cannot be enriched.
     */
    async enrichTV(candidate: AvailableCandidate): Promise<EnrichedContent | null> {
      try {
        const data = await get<TMDbTVDetails>(`/tv/${candidate.tmdbId}`, {
          append_to_response: 'keywords,credits,content_ratings',
        })

        if (!data.overview?.trim()) return null

        const castNames = data.credits.cast
          .filter(c => c.known_for_department === 'Acting')
          .sort((a, b) => a.order - b.order)
          .slice(0, 5)
          .map(c => c.name)

        const directorNames = data.credits.crew
          .filter(c => c.job === 'Director')
          .map(c => c.name)

        const usRating = data.content_ratings.results.find(r => r.iso_3166_1 === 'US')

        const avgEpisodeMinutes = data.episode_run_time.length > 0
          ? Math.round(data.episode_run_time.reduce((a, b) => a + b, 0) / data.episode_run_time.length)
          : null

        return {
          ...candidate,
          description: data.overview.trim(),
          genres: data.genres.map(g => g.name),
          castNames,
          directorNames,
          runtimeMinutes: null,
          avgEpisodeMinutes,
          seasonCount: data.number_of_seasons,
          tmdbRating: data.vote_average,
          tmdbVoteCount: data.vote_count,
          posterUrl: data.poster_path ? `${IMAGE_BASE_W500}${data.poster_path}` : null,
          backdropUrl: data.backdrop_path ? `${IMAGE_BASE_W1280}${data.backdrop_path}` : null,
          contentRating: usRating?.rating ?? null,
          // TV keywords are nested under `results` not `keywords`
          tmdbKeywords: data.keywords.results.map(k => k.name.toLowerCase().trim()),
        }
      } catch {
        return null
      }
    },
  }
}
