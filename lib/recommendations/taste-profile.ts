// TasteProfileService — the ONE place a user's category-affinity prior is computed and loaded.
//
// It produces a TasteProfile (a category-id → affinity map, centered at 0.5/neutral) that is the single
// shared signal behind BOTH better search ranking (scoring.ts reads it) AND the future no-query "For You"
// experience. Built deliberately thin: a pure computation (testable without a DB) + a cached loader.
//
// UX intent: the 50-swipe onboarding only feels worth it if it visibly sharpens results. A per-category
// prior aggregated over ~10 swipes each is far less noisy than per-title tag overlap, so even the user's
// FIRST search reflects their taste. This module is that prior.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { CATEGORY_IDS, NEUTRAL_AFFINITY, getCategory } from '@/lib/onboarding/categories'

export { NEUTRAL_AFFINITY }

/** Minimum affinity above neutral for a category to count as a "liked" signal worth surfacing. */
const FOR_YOU_LIKED_THRESHOLD = NEUTRAL_AFFINITY + 0.05
/** Generic fallback when the user has no clear positive categories (keeps the For-You rail non-empty). */
const FOR_YOU_FALLBACK_QUERY = 'popular, highly rated movies and shows'

/**
 * TEMPORARY (v1) synthetic query for the no-query "For You" path: the labels of the user's top positive
 * categories, embedded by the normal retrieval pipeline. Deterministic, cheap, and good enough to seed a
 * taste-shaped candidate pool that the categoryAffinity scorer then re-ranks.
 *
 * TODO(centroid): replace this with affinity-weighted category-centroid retrieval — precompute per-category
 * centroid embeddings (mean of member titles' vectors) and a match_content_centroid RPC, then retrieve by
 * the weighted centroid. That removes the lossy text round-trip. Tracked as RAL N15.
 */
export function forYouEmbedQuery(profile: TasteProfile): string {
  const top = [...profile.categoryAffinities.entries()]
    .filter(([, a]) => a >= FOR_YOU_LIKED_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => getCategory(id)?.label ?? id)
  return top.length > 0 ? top.join(', ') : FOR_YOU_FALLBACK_QUERY
}

/** How far a fully one-sided category (all-liked or all-disliked) moves from neutral. 0.5 → spans [0,1]. */
const AFFINITY_SPREAD = 0.5

// Per-action contribution to a category's mean signal. 'not_seen' = "interested but unwatched" → mild +.
// 'favourite_genre' = a follow-up "Most Favourite Items" pick → a strong positive, but deliberately below a
// swipe_liked so one tap doesn't outweigh a category the user actually swiped through.
const ACTION_WEIGHT: Record<string, number> = {
  swipe_liked: 1,
  favourite_genre: 0.75,
  swipe_not_seen: 0.25,
  swipe_disliked: -1,
}

export type TasteProfile = {
  /** category id → affinity in [0,1] (0.5 neutral). Missing category ⇒ neutral. */
  categoryAffinities: Map<string, number>
}

/** A computed affinity row, ready to upsert into user_category_affinity. */
export type CategoryAffinityRow = { category: string; affinity: number; sampleCount: number }

/** One swipe's contribution, normalized to (category, action). */
export type SwipeSignal = { category: string; action: keyof typeof ACTION_WEIGHT }

/**
 * PURE: turns the onboarding swipes into per-category affinities. For each category, affinity =
 * 0.5 + mean(action weights) × spread, clamped to [0,1]. Categories with no swipes are simply absent
 * (callers treat absence as neutral). Deterministic and DB-free, so it's unit-tested in isolation.
 */
export function computeCategoryAffinities(signals: SwipeSignal[]): CategoryAffinityRow[] {
  const byCat = new Map<string, { sum: number; n: number }>()
  for (const s of signals) {
    const w = ACTION_WEIGHT[s.action]
    if (w === undefined || !s.category) continue
    const agg = byCat.get(s.category) ?? { sum: 0, n: 0 }
    agg.sum += w
    agg.n += 1
    byCat.set(s.category, agg)
  }
  const rows: CategoryAffinityRow[] = []
  for (const [category, { sum, n }] of byCat) {
    if (n === 0) continue
    const affinity = clamp01(NEUTRAL_AFFINITY + (sum / n) * AFFINITY_SPREAD)
    rows.push({ category, affinity: round3(affinity), sampleCount: n })
  }
  return rows
}

/** An empty (all-neutral) profile — the fail-open / no-signal default. */
export function emptyTasteProfile(): TasteProfile {
  return { categoryAffinities: new Map() }
}

// ─── Cached loader ────────────────────────────────────────────────────────────────

export type TasteProfileDeps = {
  logger?: Logger
  /** Injectable clock for cache-TTL tests. */
  now?: () => number
  /** Bypass the cache (tests) — always read fresh. */
  skipCache?: boolean
}

// Light in-process cache: a profile changes only when onboarding re-runs, so a short TTL keeps the hot
// path free of an extra query without risking staleness that matters. Keyed by userId.
const CACHE_TTL_MS = Number(process.env.TASTE_PROFILE_CACHE_TTL_MS) || 60_000
const cache = new Map<string, { profile: TasteProfile; expiresAt: number }>()

/**
 * Loads a user's TasteProfile from user_category_affinity. Works for anonymous and permanent users (both
 * have a profile). FAIL-OPEN: any error → an empty (neutral) profile, so a personalization hiccup never
 * blocks recommendations. Lightly cached per user.
 */
export async function loadTasteProfile(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  deps: TasteProfileDeps = {}
): Promise<TasteProfile> {
  const logger = deps.logger ?? noopLogger
  const now = deps.now ?? Date.now
  const useCache = !deps.skipCache

  if (useCache) {
    const hit = cache.get(userId)
    if (hit && hit.expiresAt > now()) return hit.profile
  }

  let profile = emptyTasteProfile()
  try {
    const { data, error } = await supabase
      .from('user_category_affinity')
      .select('category, affinity')
      .eq('user_id', userId)
    if (error) {
      logger.warn('taste profile load failed (neutral fallback)', { message: error.message })
    } else {
      profile = rowsToProfile((data ?? []) as Array<{ category: string; affinity: unknown }>)
    }
  } catch (err) {
    logger.warn('taste profile load threw (neutral fallback)', {
      message: err instanceof Error ? err.message : String(err),
    })
  }

  if (useCache) cache.set(userId, { profile, expiresAt: now() + CACHE_TTL_MS })
  return profile
}

/** PURE: validate + map affinity rows into a profile. Unknown categories are dropped, bad values skipped. */
export function rowsToProfile(rows: Array<{ category: string; affinity: unknown }>): TasteProfile {
  const known = new Set(CATEGORY_IDS)
  const map = new Map<string, number>()
  for (const r of rows) {
    if (!known.has(r.category)) continue
    const a = typeof r.affinity === 'number' ? r.affinity : Number(r.affinity)
    if (Number.isFinite(a)) map.set(r.category, clamp01(a))
  }
  return { categoryAffinities: map }
}

/** Test helper — clears the per-user cache so a test's fixture state is read fresh. */
export function __resetTasteProfileCacheForTests(): void {
  cache.clear()
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return NEUTRAL_AFFINITY
  return Math.max(0, Math.min(1, n))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
