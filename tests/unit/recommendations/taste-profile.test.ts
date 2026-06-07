import { describe, expect, it } from 'vitest'
import {
  computeCategoryAffinities,
  emptyTasteProfile,
  forYouEmbedQuery,
  rowsToProfile,
  NEUTRAL_AFFINITY,
} from '@/lib/recommendations/taste-profile'

describe('computeCategoryAffinities', () => {
  it('returns no rows for no signals', () => {
    expect(computeCategoryAffinities([])).toEqual([])
  })

  it('all-liked in a category → max affinity (1.0) with the sample count', () => {
    const signals = Array.from({ length: 10 }, () => ({ category: 'crime_thriller', action: 'swipe_liked' as const }))
    const [row] = computeCategoryAffinities(signals)
    expect(row).toMatchObject({ category: 'crime_thriller', affinity: 1, sampleCount: 10 })
  })

  it('all-disliked → min affinity (0.0)', () => {
    const signals = Array.from({ length: 4 }, () => ({ category: 'drama_prestige', action: 'swipe_disliked' as const }))
    expect(computeCategoryAffinities(signals)[0]).toMatchObject({ affinity: 0, sampleCount: 4 })
  })

  it('a balanced mix lands at neutral', () => {
    const signals = [
      { category: 'comedy_feelgood', action: 'swipe_liked' as const },
      { category: 'comedy_feelgood', action: 'swipe_disliked' as const },
    ]
    expect(computeCategoryAffinities(signals)[0].affinity).toBeCloseTo(0.5, 5)
  })

  it("'favourite_genre' is a strong positive, but below a swipe_liked", () => {
    const fav = computeCategoryAffinities([{ category: 'action_adventure', action: 'favourite_genre' }])[0].affinity
    const liked = computeCategoryAffinities([{ category: 'action_adventure', action: 'swipe_liked' }])[0].affinity
    const notSeen = computeCategoryAffinities([{ category: 'action_adventure', action: 'swipe_not_seen' }])[0].affinity
    expect(fav).toBeGreaterThan(notSeen)
    expect(fav).toBeLessThan(liked)
  })

  it('a favourite pick can lift a category the user never swiped', () => {
    const [row] = computeCategoryAffinities([{ category: 'drama_prestige', action: 'favourite_genre' }])
    expect(row.category).toBe('drama_prestige')
    expect(row.affinity).toBeGreaterThan(0.5)
    expect(row.sampleCount).toBe(1)
  })

  it("'not_seen' contributes a mild positive signal (less than a like)", () => {
    const notSeen = computeCategoryAffinities([{ category: 'sci_fi_fantasy', action: 'swipe_not_seen' }])[0].affinity
    const liked = computeCategoryAffinities([{ category: 'sci_fi_fantasy', action: 'swipe_liked' }])[0].affinity
    expect(notSeen).toBeGreaterThan(0.5)
    expect(notSeen).toBeLessThan(liked)
  })

  it('aggregates per category independently', () => {
    const rows = computeCategoryAffinities([
      { category: 'crime_thriller', action: 'swipe_liked' },
      { category: 'crime_thriller', action: 'swipe_liked' },
      { category: 'drama_prestige', action: 'swipe_disliked' },
    ])
    const byCat = Object.fromEntries(rows.map((r) => [r.category, r]))
    expect(byCat.crime_thriller.affinity).toBe(1)
    expect(byCat.crime_thriller.sampleCount).toBe(2)
    expect(byCat.drama_prestige.affinity).toBe(0)
  })

  it('ignores signals with no category', () => {
    expect(computeCategoryAffinities([{ category: '', action: 'swipe_liked' }])).toEqual([])
  })
})

describe('rowsToProfile', () => {
  it('maps known categories and coerces numeric strings', () => {
    const profile = rowsToProfile([
      { category: 'crime_thriller', affinity: 0.8 },
      { category: 'sci_fi_fantasy', affinity: '0.3' as unknown as number },
    ])
    expect(profile.categoryAffinities.get('crime_thriller')).toBeCloseTo(0.8, 5)
    expect(profile.categoryAffinities.get('sci_fi_fantasy')).toBeCloseTo(0.3, 5)
  })

  it('drops unknown categories and non-finite values', () => {
    const profile = rowsToProfile([
      { category: 'not_a_real_category', affinity: 0.9 },
      { category: 'drama_prestige', affinity: 'nope' as unknown as number },
    ])
    expect(profile.categoryAffinities.size).toBe(0)
  })

  it('clamps out-of-range values', () => {
    const profile = rowsToProfile([{ category: 'crime_thriller', affinity: 5 }])
    expect(profile.categoryAffinities.get('crime_thriller')).toBe(1)
  })
})

describe('emptyTasteProfile', () => {
  it('is an empty (all-neutral) profile', () => {
    expect(emptyTasteProfile().categoryAffinities.size).toBe(0)
    expect(NEUTRAL_AFFINITY).toBe(0.5)
  })
})

describe('forYouEmbedQuery', () => {
  const FALLBACK = 'popular, highly rated movies and shows'

  it('falls back when there are no positive categories', () => {
    expect(forYouEmbedQuery(emptyTasteProfile())).toBe(FALLBACK)
    // neutral/negative categories don't qualify
    expect(
      forYouEmbedQuery({ categoryAffinities: new Map([['crime_thriller', 0.5], ['drama_prestige', 0.2]]) })
    ).toBe(FALLBACK)
  })

  it('uses the labels of the top positive categories, highest affinity first', () => {
    const q = forYouEmbedQuery({
      categoryAffinities: new Map([
        ['crime_thriller', 0.7],
        ['sci_fi_fantasy', 0.95],
        ['comedy_feelgood', 0.62],
      ]),
    })
    expect(q).toBe('Sci-Fi & Fantasy, Crime & Thriller, Comedy')
  })

  it('caps at the top 3', () => {
    const q = forYouEmbedQuery({
      categoryAffinities: new Map([
        ['crime_thriller', 0.9],
        ['sci_fi_fantasy', 0.85],
        ['comedy_feelgood', 0.8],
        ['drama_prestige', 0.75],
        ['action_adventure', 0.7],
      ]),
    })
    expect(q.split(', ')).toHaveLength(3)
  })
})
