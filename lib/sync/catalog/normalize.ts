// Normalization — movieofthenight Show → internal IngestedTitle. Pure + unit-testable.
//
// Handles the live-contract quirks confirmed against the API:
//   • tmdbId arrives prefixed: "movie/872790" / "tv/136369" → parse to integer + type.
//   • genres are { id, name } objects.
//   • crew is `directors` (movies) or `creators` (series).
//   • poster image URLs are time-signed and rotate, so daily refresh keeps them fresh; we prefer a
//     mid-size vertical poster and fall back through the available widths.

import type { ContentType, StreamingType } from '@/lib/types/sync'
import type { CatalogAvailability, IngestedTitle, MotnShow } from '@/lib/sync/catalog/types'

/** Parses motn's prefixed tmdbId ("movie/872790" | "tv/136369") into an integer + content type. */
export function parseTmdbId(raw: string | undefined): { tmdbId: number | null; type: ContentType | null } {
  if (!raw) return { tmdbId: null, type: null }
  const [prefix, idStr] = raw.split('/')
  const id = Number(idStr)
  const tmdbId = Number.isInteger(id) && id > 0 ? id : null
  const type = prefix === 'movie' ? 'movie' : prefix === 'tv' ? 'series' : null
  return { tmdbId, type }
}

/** motn streaming `type` → our enum. 'addon' (paid channel add-on) maps to subscription; unknown → null. */
export function mapStreamingType(type: string): StreamingType | null {
  switch (type) {
    case 'subscription':
    case 'free':
    case 'rent':
    case 'buy':
      return type
    case 'addon':
      return 'subscription'
    default:
      return null
  }
}

/** Picks a stable-ish poster URL, preferring a mid-size vertical poster. */
export function pickPoster(variant: Record<string, string> | undefined): string | null {
  if (!variant) return null
  for (const w of ['w480', 'w600', 'w360', 'w720', 'w240']) {
    if (variant[w]) return variant[w]
  }
  const any = Object.values(variant)[0]
  return any ?? null
}

function unixToDate(ts: number | undefined): Date | null {
  return ts != null ? new Date(ts * 1000) : null
}

/**
 * Normalizes a motn Show for a specific platform + region. Returns null when the show carries no
 * usable availability option for that platform (so it isn't ingested as available there).
 */
export function normalizeShow(
  show: MotnShow,
  platformSlug: string,
  region: string
): IngestedTitle | null {
  const options = show.streamingOptions?.[region] ?? []
  const availability: CatalogAvailability[] = []
  for (const opt of options) {
    if (opt.service.id !== platformSlug) continue
    const streamingType = mapStreamingType(opt.type)
    if (!streamingType) continue
    availability.push({
      platformSlug,
      region,
      deepLink: opt.link ?? null,
      streamingType,
      availableFrom: unixToDate(opt.availableSince),
      availableUntil: null, // motn v4 exposes expiresSoon (bool), not a date; refresh catches removals
    })
  }
  if (availability.length === 0) return null

  const { tmdbId, type: tmdbType } = parseTmdbId(show.tmdbId)
  const type: ContentType = tmdbType ?? show.showType
  const contentKey = tmdbId != null ? `tmdb:${tmdbId}` : `motn:${show.id}`

  return {
    contentKey,
    motnId: show.id,
    tmdbId,
    imdbId: show.imdbId ?? null,
    type,
    title: show.title,
    releaseYear: show.releaseYear ?? show.firstAirYear ?? null,
    description: show.overview?.trim() || null,
    genres: (show.genres ?? []).map((g) => g.name).filter(Boolean),
    castNames: (show.cast ?? []).slice(0, 8),
    directorNames: (show.directors ?? show.creators ?? []).slice(0, 5),
    runtimeMinutes: show.runtime ?? null,
    seasonCount: show.seasonCount ?? null,
    posterUrl: pickPoster(show.imageSet?.verticalPoster),
    backdropUrl: pickPoster(show.imageSet?.horizontalBackdrop),
    motnRating: typeof show.rating === 'number' ? show.rating : null,
    availability,
  }
}
