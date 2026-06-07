// Category registry — the SINGLE source of truth for the onboarding swipe categories AND the category
// taxonomy the recommendation engine personalizes against. Add/rename a category here and the deck,
// affinity computation, and scoring all follow; nothing else hard-codes category ids.
//
// UX intent: 5 broad, low-overlap buckets that (a) cover the catalog, (b) give the 50-swipe onboarding a
// clear "you're rating Crime & Thriller now" header per section, and (c) yield a denoised per-category
// taste prior that visibly sharpens the user's very first search.
//
// Documentaries are deliberately NOT a swipe category and NOT a content.type — Documentary is a GENRE
// (it spans movies AND series). It's surfaced via the follow-up questions + a genre filter, never here.

import type { ContentRow } from '@/lib/types/content'

/** Neutral category affinity — a title in a category the user gave no signal on is neither helped nor hurt. */
export const NEUTRAL_AFFINITY = 0.5

export type SwipeCategory = {
  /** Stable id used as the key everywhere (DB rows, affinity maps). Never user-facing. */
  id: string
  /** Header shown above this section of the swipe deck. */
  label: string
  /** One-line framing under the header — sets the mood for honest swiping. */
  blurb: string
  /** Catalog genre strings that belong to this category (case-insensitive match against content.genres). */
  genreMatchers: string[]
}

// Order = priority for tie-breaks / display. Genre strings cover both TMDb movie and TV genre names
// (e.g. 'Science Fiction' for film, 'Sci-Fi & Fantasy' for series) so a title matches regardless of type.
export const SWIPE_CATEGORIES: readonly SwipeCategory[] = [
  {
    id: 'crime_thriller',
    label: 'Crime & Thriller',
    blurb: 'Whodunnits, heists, slow-burn tension.',
    genreMatchers: ['Crime', 'Thriller', 'Mystery', 'War & Politics'],
  },
  {
    id: 'sci_fi_fantasy',
    label: 'Sci-Fi & Fantasy',
    blurb: 'Other worlds, big ideas, the impossible.',
    genreMatchers: ['Science Fiction', 'Sci-Fi & Fantasy', 'Fantasy'],
  },
  {
    id: 'comedy_feelgood',
    label: 'Comedy & Feel-Good',
    blurb: 'Light, warm, easy to love.',
    genreMatchers: ['Comedy', 'Family', 'Music', 'Romance'],
  },
  {
    id: 'drama_prestige',
    label: 'Drama & Prestige',
    blurb: 'Character-driven, awards-bait, the heavy hitters.',
    genreMatchers: ['Drama', 'History', 'War'],
  },
  {
    id: 'action_adventure',
    label: 'Action & Adventure',
    blurb: 'Momentum, spectacle, a ride.',
    genreMatchers: ['Action', 'Adventure', 'Action & Adventure', 'Western'],
  },
] as const

export type CategoryId = (typeof SWIPE_CATEGORIES)[number]['id']

export const CATEGORY_IDS: readonly string[] = SWIPE_CATEGORIES.map((c) => c.id)

// Genre → categories index, built once. A genre can belong to several categories in principle; in this
// starter set they're disjoint, but the structure tolerates overlap.
const GENRE_TO_CATEGORIES: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const cat of SWIPE_CATEGORIES) {
    for (const g of cat.genreMatchers) {
      const key = g.trim().toLowerCase()
      const list = m.get(key) ?? []
      list.push(cat.id)
      m.set(key, list)
    }
  }
  return m
})()

export function getCategory(id: string): SwipeCategory | undefined {
  return SWIPE_CATEGORIES.find((c) => c.id === id)
}

/**
 * All categories a title belongs to, by its genres (case-insensitive, de-duplicated). Empty when the
 * title's genres fall entirely outside the registry (e.g. a pure Documentary/Animation/Horror title) —
 * such titles simply receive a neutral category-affinity, never a penalty.
 */
export function categoriesOf(content: Pick<ContentRow, 'genres'>): string[] {
  const out = new Set<string>()
  for (const g of content.genres) {
    const ids = GENRE_TO_CATEGORIES.get(g.trim().toLowerCase())
    if (ids) for (const id of ids) out.add(id)
  }
  return [...out]
}
