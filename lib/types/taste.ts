// Taste-seed domain types — a user's onboarding ratings used for personalization.
//
// A taste seed is a (content, sentiment) pair from `user_taste_seeds`. Carrying the full
// ContentRow (not just an id) lets scoring read the seed's genres/mood/theme tags and lets
// explanations reference the seed's title ("because you loved X") — both without extra I/O.
// The raw embedding is intentionally omitted here too, mirroring ContentRow: v1 personalization
// is metadata-based; embedding-cosine personalization is a documented v2 upgrade.

import { z } from 'zod'
import type { ContentRow } from '@/lib/types/content'

export const TASTE_SENTIMENTS = ['loved', 'liked', 'disliked'] as const
export type TasteSentiment = (typeof TASTE_SENTIMENTS)[number]

export const tasteSentimentSchema = z.enum(TASTE_SENTIMENTS)

/** One onboarding rating: how the user felt about a title they were shown. */
export type TasteSeed = {
  sentiment: TasteSentiment
  content: ContentRow
}
