// Onboarding domain types — the swipe deck, follow-up answers, and the completion payload.
// Zod schemas are the source of truth; the API routes validate against them.

import { z } from 'zod'
import { CONTENT_TYPES } from '@/lib/types/content'

// ─── Swipe deck (server → client) ─────────────────────────────────────────────

/** A title shown in the onboarding swipe deck. */
export type SwipeTitle = {
  id: string
  title: string
  type: (typeof CONTENT_TYPES)[number]
  releaseYear: number | null
  posterUrl: string | null
  genres: string[]
}

/** One category's section of the swipe deck (header + its 10 titles). */
export type SwipeCategoryDeck = {
  /** Category id from the registry (lib/onboarding/categories.ts) — sent back on each swipe. */
  id: string
  label: string
  blurb: string
  titles: SwipeTitle[]
}

export type SwipeDeckResponse = { categories: SwipeCategoryDeck[] }

// ─── Follow-up answers ─────────────────────────────────────────────────────────

export const CONTENT_PREF_OPTIONS = ['movie', 'series', 'any'] as const
export const RUNTIME_OPTIONS = ['short', 'hour', 'movie', 'any'] as const
// Common "rather not" genres → canonical catalog genre strings (become default excludeGenres).
export const AVOID_GENRE_OPTIONS = ['Horror', 'Romance', 'Reality', 'Documentary', 'Animation'] as const

// Every preference here maps to a real engine knob (content type, excluded genres, runtime cap), so
// answers shape results — not just stored for "later".
export const preferencesSchema = z.object({
  contentType: z.enum(CONTENT_PREF_OPTIONS).optional(),
  avoidGenres: z.array(z.string().min(1)).max(10).optional(),
  runtime: z.enum(RUNTIME_OPTIONS).optional(),
})
export type Preferences = z.infer<typeof preferencesSchema>

// ─── Completion payload (client → server) ─────────────────────────────────────

// A swipe carries the deck `category` it came from, an `action`, and (for like/dislike) a SENTIMENT that
// seeds ranking. A 'not_seen' swipe means "interested but unwatched" — it is NOT a taste-seed sentiment, so
// `sentiment` is OPTIONAL and simply omitted for not_seen (only an interaction is logged, plus a mild
// positive category-affinity signal). `category`/`action` remain optional so the pre-5×10 client (which
// sent only {contentId, sentiment}) still validates.
export const swipeSchema = z.object({
  contentId: z.string().uuid(),
  sentiment: z.enum(['liked', 'disliked']).optional(),
  /** Deck category id this title was shown in (see lib/onboarding/categories.ts). */
  category: z.string().min(1).max(64).optional(),
  /** Explicit interaction action; derived from `sentiment` when absent. Required to express 'not_seen'. */
  action: z.enum(['swipe_liked', 'swipe_disliked', 'swipe_not_seen']).optional(),
})
export type Swipe = z.infer<typeof swipeSchema>

export const completeOnboardingSchema = z.object({
  swipes: z.array(swipeSchema).max(100),
  /** Subscribed platform slugs (netflix/prime/disney) → stored in preferred_platforms. */
  platforms: z.array(z.string().min(1)).max(10).default([]),
  preferences: preferencesSchema.default({}),
})
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>
