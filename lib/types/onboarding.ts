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

export type SwipeDeckResponse = { titles: SwipeTitle[] }

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

// Swipes are positive/negative SIGNALS only — never used to exclude titles from future results.
// 'liked' → boost similar content, 'disliked' → penalize. ('up'/skip swipes send nothing.)
export const swipeSchema = z.object({
  contentId: z.string().uuid(),
  sentiment: z.enum(['liked', 'disliked']),
})
export type Swipe = z.infer<typeof swipeSchema>

export const completeOnboardingSchema = z.object({
  swipes: z.array(swipeSchema).max(100),
  /** Subscribed platform slugs (netflix/prime/disney) → stored in preferred_platforms. */
  platforms: z.array(z.string().min(1)).max(10).default([]),
  preferences: preferencesSchema.default({}),
})
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>
