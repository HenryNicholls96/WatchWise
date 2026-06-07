// User defaults — the single, explicit adapter from a user's stored onboarding answers to engine
// filter defaults. This is intentionally the ONLY place onboarding preferences flow into the
// recommendation pipeline, so "why these results" stays traceable.
//
// Boundaries & precedence (enforced by the engine that consumes this):
//   • These are DEFAULTS, not settings — applied only where the caller didn't specify this session.
//     Precedence: explicit API param  >  parsed query intent  >  onboarding default (this file).
//   • Swipes are NOT here: liked swipes are positive TasteSeeds that drive *ranking*
//     (computePersonalization), entirely separate from these *eligibility* filters.
//   • Fail-open: onboarding never produces a per-title exclusion (excludeContentIds). The only
//     exclusion it contributes is a genre-level avoid list, which the engine applies softly
//     (relaxes if it would empty results) and which never overrides a title the user explicitly
//     liked (the engine passes liked seeds as protected ids to the genre filter).

import type { ContentType } from '@/lib/types/content'
import type { Logger } from '@/lib/types/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

export type UserDefaults = {
  /** From preferred_platforms — default platform allow-set when none is requested this session. */
  platformSlugs?: string[]
  /** From preferences.mediaType ('movie'/'series'); legacy preferences.contentType honored as fallback. */
  contentType?: ContentType
  /** Required genres (hard inclusion filter). From mediaType 'documentary' → ['Documentary']. */
  requireGenres?: string[]
  /** Derived from a legacy preferences.runtime answer (see RUNTIME_CAP_MINUTES). */
  maxRuntimeMinutes?: number
  /** From preferences.avoidGenres — canonical genre strings, applied as a soft default exclusion. */
  excludeGenres?: string[]
}

// Runtime answer → an upper minutes cap. "movie"/"any" intentionally impose no cap (a movie-length
// preference is about wanting films, not capping length). Kept deliberately generous to avoid
// over-constraining a standing default.
const RUNTIME_CAP_MINUTES: Record<string, number | undefined> = {
  short: 45,
  hour: 90,
  movie: undefined,
  any: undefined,
}

/** Pure mapping from a profile row to engine defaults. Unit-testable; tolerant of partial/odd data. */
export function profileToDefaults(row: {
  preferred_platforms?: unknown
  preferences?: unknown
}): UserDefaults {
  const defaults: UserDefaults = {}

  const platforms = Array.isArray(row.preferred_platforms)
    ? row.preferred_platforms.filter((p): p is string => typeof p === 'string')
    : []
  if (platforms.length > 0) defaults.platformSlugs = platforms

  const prefs = (row.preferences ?? {}) as Record<string, unknown>

  // Media type (new) takes precedence. 'documentary' → hard Documentary-genre filter; 'all' → no
  // restriction; 'movie'/'series' → content-type filter. Falls back to a legacy `contentType` answer so
  // profiles written before the follow-up revamp keep working.
  if (prefs.mediaType === 'movie' || prefs.mediaType === 'series') {
    defaults.contentType = prefs.mediaType
  } else if (prefs.mediaType === 'documentary') {
    defaults.requireGenres = ['Documentary']
  } else if (prefs.mediaType !== 'all') {
    if (prefs.contentType === 'movie' || prefs.contentType === 'series') {
      defaults.contentType = prefs.contentType
    }
  }

  if (typeof prefs.runtime === 'string') {
    const cap = RUNTIME_CAP_MINUTES[prefs.runtime]
    if (cap != null) defaults.maxRuntimeMinutes = cap
  }

  const avoid = Array.isArray(prefs.avoidGenres)
    ? prefs.avoidGenres.filter((g): g is string => typeof g === 'string')
    : []
  if (avoid.length > 0) defaults.excludeGenres = avoid

  return defaults
}

/**
 * Loads a user's onboarding-derived engine defaults. Works for authenticated AND anonymous users
 * (both have a user_profiles row). Fail-open: any error (or no profile) yields empty defaults, so a
 * profile issue never blocks recommendations.
 */
export async function loadUserDefaults(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  logger: Logger
): Promise<UserDefaults> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('preferred_platforms, preferences')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    logger.warn('user defaults load failed (non-fatal)', { message: error.message })
    return {}
  }
  if (!data) return {}
  return profileToDefaults(data as { preferred_platforms?: unknown; preferences?: unknown })
}
