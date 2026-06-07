// Interaction domain types — the closed vocabulary for the append-only user_content_interactions log.
// Zod is the source of truth; the DB mirrors it via a CHECK constraint (migration 009).
//
// Separation of concern: a "seed" (user_taste_seeds) is the cold-start sentiment that seeds RANKING; an
// "interaction" here is any ongoing behavioural signal (seen / dismissed / not-interested / quick
// sentiment) PLUS the immutable record of each onboarding swipe. Reads take the latest row per title.

import { z } from 'zod'

export const INTERACTION_ACTIONS = [
  // Immutable record of an onboarding swipe (mirrors the sentiment, but never mutated).
  'swipe_liked',
  'swipe_disliked',
  'swipe_not_seen',
  // Ongoing discovery signals.
  'marked_seen', // user told us they've watched it
  'dismissed', // user tapped ✕ on a card
  'not_interested', // explicit "not for me" without sentiment
  // Optional quick sentiment (progressive disclosure on a card).
  'loved',
  'not_for_me',
] as const

export type InteractionAction = (typeof INTERACTION_ACTIONS)[number]

/** Actions that imply the user has WATCHED the title — the basis for the "already seen" set. */
export const SEEN_ACTIONS: readonly InteractionAction[] = [
  'swipe_liked',
  'swipe_disliked',
  'marked_seen',
  'loved',
  'not_for_me',
]

/** Actions that should SUPPRESS a title from results (user actively rejected it). */
export const SUPPRESS_ACTIONS: readonly InteractionAction[] = ['dismissed', 'not_interested']

export const interactionSourceSchema = z.enum(['onboarding', 'discovery'])
export type InteractionSource = z.infer<typeof interactionSourceSchema>

export const interactionActionSchema = z.enum(INTERACTION_ACTIONS)

/** One row to append to user_content_interactions. */
export type InteractionInsert = {
  user_id: string
  content_id: string
  action: InteractionAction
  category?: string | null
  source: InteractionSource
  context?: Record<string, unknown>
}
