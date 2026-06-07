import { describe, expect, it } from 'vitest'
import type { Candidate, ContentRow } from '@/lib/types/content'
import type { TasteSeed } from '@/lib/types/taste'
import {
  DEFAULT_SCORE_WEIGHTS,
  SCORE_WEIGHTS,
  SIMILARITY_FLOOR,
  ScoringError,
  buildScoreWeights,
  computeCategoryAffinity,
  computePersonalization,
  computeQualityScore,
  getCategoryAffinityWeight,
  scoreAndRank,
  tagOverlap,
} from '@/lib/recommendations/scoring'

// ─── fixtures ───────────────────────────────────────────────────────────────

function content(overrides: Partial<ContentRow> = {}): ContentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    tmdbId: 1,
    title: 'Test Title',
    type: 'series',
    releaseYear: 2020,
    description: null,
    genres: [],
    moodTags: [],
    themeTags: [],
    castNames: [],
    directorNames: [],
    runtimeMinutes: null,
    avgEpisodeMinutes: null,
    seasonCount: null,
    imdbRating: null,
    tmdbRating: null,
    tmdbVoteCount: null,
    posterUrl: null,
    backdropUrl: null,
    originalLanguage: 'en',
    contentRating: null,
    blendedRating: null,
    ratingSources: null,
    ...overrides,
  }
}

function candidate(vectorSimilarity: number, overrides: Partial<ContentRow> = {}): Candidate {
  return { content: content(overrides), vectorSimilarity }
}

function seed(sentiment: TasteSeed['sentiment'], overrides: Partial<ContentRow> = {}): TasteSeed {
  return { sentiment, content: content(overrides) }
}

// ─── tagOverlap ─────────────────────────────────────────────────────────────

describe('tagOverlap', () => {
  it('is 1 for identical tag sets and case-insensitive', () => {
    const a = content({ genres: ['Crime'], moodTags: ['Dark'] })
    const b = content({ genres: ['crime'], moodTags: ['dark'] })
    expect(tagOverlap(a, b)).toBe(1)
  })

  it('is 0 when there is no shared tag', () => {
    const a = content({ genres: ['Comedy'] })
    const b = content({ genres: ['Horror'] })
    expect(tagOverlap(a, b)).toBe(0)
  })

  it('is 0 when either side has no tags (absent metadata is not similarity)', () => {
    const tagged = content({ genres: ['Drama'] })
    const bare = content()
    expect(tagOverlap(tagged, bare)).toBe(0)
    expect(tagOverlap(bare, bare)).toBe(0)
  })

  it('computes Jaccard for partial overlap', () => {
    // union {crime, drama, thriller} = 3, intersection {crime} = 1
    const a = content({ genres: ['Crime', 'Drama'] })
    const b = content({ genres: ['Crime', 'Thriller'] })
    expect(tagOverlap(a, b)).toBeCloseTo(1 / 3, 5)
  })

  it('merges genres, mood and theme into one set', () => {
    const a = content({ genres: ['Crime'], moodTags: ['dark'], themeTags: ['heist'] })
    const b = content({ themeTags: ['heist'] })
    // union {crime, dark, heist} = 3, intersection {heist} = 1
    expect(tagOverlap(a, b)).toBeCloseTo(1 / 3, 5)
  })
})

// ─── computePersonalization ─────────────────────────────────────────────────

describe('computePersonalization', () => {
  const candidateContent = content({ genres: ['Crime', 'Drama'], moodTags: ['dark'] })

  it('returns neutral 0.5 with no seeds', () => {
    expect(computePersonalization(candidateContent, [])).toBe(0.5)
  })

  it('lifts above neutral for full overlap with a loved seed (damped by 0.65)', () => {
    const seeds = [seed('loved', { genres: ['Crime', 'Drama'], moodTags: ['dark'] })]
    // loved = 0.65; affinity = 0.5 × 0.65 = 0.325 → 0.5 + 0.325
    expect(computePersonalization(candidateContent, seeds)).toBeCloseTo(0.825, 5)
  })

  it('lifts less for a liked seed than a loved seed', () => {
    const liked = computePersonalization(candidateContent, [
      seed('liked', { genres: ['Crime', 'Drama'], moodTags: ['dark'] }),
    ])
    // liked = 0.65; affinity = 0.25 × 0.65 = 0.1625 → 0.6625
    expect(liked).toBeCloseTo(0.6625, 5)
    expect(liked).toBeLessThan(0.825)
  })

  it('drops below neutral for full overlap with a disliked seed (damped by 0.65)', () => {
    const seeds = [seed('disliked', { genres: ['Crime', 'Drama'], moodTags: ['dark'] })]
    // disliked = 0.65; aversion = 0.5 × 0.65 = 0.325 → 0.5 - 0.325
    expect(computePersonalization(candidateContent, seeds)).toBeCloseTo(0.175, 5)
  })

  it('compounds multiple same-sentiment seeds (cumulative, not max)', () => {
    const oneSeed = [seed('loved', { genres: ['Crime'] })] // overlap 1/3
    const twoSeeds = [
      seed('loved', { genres: ['Crime'] }), // overlap 1/3
      seed('loved', { moodTags: ['dark'] }), // overlap 1/3
    ]
    const one = computePersonalization(candidateContent, oneSeed)
    const two = computePersonalization(candidateContent, twoSeeds)
    // Two corroborating loved seeds must score strictly higher than one — the old max() collapsed them.
    expect(two).toBeGreaterThan(one)
    expect(one).toBeGreaterThan(0.5)
  })

  it('ignores zero-overlap seeds when accumulating', () => {
    const seeds = [
      seed('loved', { genres: ['Unrelated'] }), // overlap 0 — adds nothing
      seed('loved', { genres: ['Crime', 'Drama'], moodTags: ['dark'] }), // overlap 1
    ]
    expect(computePersonalization(candidateContent, seeds)).toBeCloseTo(0.825, 5)
  })

  it('nets affinity against aversion and clamps to [0,1]', () => {
    const seeds = [
      seed('loved', { genres: ['Crime', 'Drama'], moodTags: ['dark'] }), // +0.5
      seed('disliked', { genres: ['Crime', 'Drama'], moodTags: ['dark'] }), // -0.5
    ]
    expect(computePersonalization(candidateContent, seeds)).toBeCloseTo(0.5, 5)
  })

  it('stays neutral when seeds share no tags with the candidate', () => {
    const seeds = [seed('loved', { genres: ['Romance'] }), seed('disliked', { genres: ['Horror'] })]
    expect(computePersonalization(candidateContent, seeds)).toBe(0.5)
  })
})

// ─── computeQualityScore ────────────────────────────────────────────────────

describe('computeQualityScore', () => {
  it('is 0 when there is no rating at all', () => {
    expect(computeQualityScore(content({ tmdbVoteCount: 9000 }))).toBe(0)
  })

  it('falls back to imdbRating when tmdbRating is null', () => {
    const withImdb = computeQualityScore(content({ imdbRating: 8, tmdbVoteCount: 5000 }))
    expect(withImdb).toBeGreaterThan(0)
  })

  it('discounts a high rating that has few votes', () => {
    const fewVotes = computeQualityScore(content({ tmdbRating: 9, tmdbVoteCount: 5 }))
    const manyVotes = computeQualityScore(content({ tmdbRating: 9, tmdbVoteCount: 5000 }))
    expect(fewVotes).toBeLessThan(manyVotes)
  })

  it('approaches normalized rating at saturation vote count', () => {
    const q = computeQualityScore(content({ tmdbRating: 8, tmdbVoteCount: 5000 }))
    expect(q).toBeCloseTo(0.8, 2)
  })

  it('treats missing vote count as zero votes', () => {
    expect(computeQualityScore(content({ tmdbRating: 9 }))).toBe(0)
  })

  it('prefers the blended rating (0–100 → [0,1]) when present', () => {
    expect(computeQualityScore(content({ blendedRating: 82 }))).toBeCloseTo(0.82, 5)
  })

  it('blended rating overrides the TMDb fallback (no vote discount applied to it)', () => {
    // tmdb path would discount by votes; blended is used directly.
    const q = computeQualityScore(content({ blendedRating: 90, tmdbRating: 5, tmdbVoteCount: 3 }))
    expect(q).toBeCloseTo(0.9, 5)
  })

  it('falls back to TMDb when blended rating is absent', () => {
    const q = computeQualityScore(content({ blendedRating: null, tmdbRating: 8, tmdbVoteCount: 5000 }))
    expect(q).toBeCloseTo(0.8, 2)
  })
})

// ─── scoreAndRank ───────────────────────────────────────────────────────────

describe('scoreAndRank', () => {
  it('throws INVALID_INPUT when candidates is not an array', () => {
    // @ts-expect-error deliberately invalid
    expect(() => scoreAndRank({ candidates: null })).toThrow(ScoringError)
  })

  it('returns an empty array for no candidates', () => {
    expect(scoreAndRank({ candidates: [] })).toEqual([])
  })

  it('treats tasteSeeds: null as no personalization (neutral scores)', () => {
    const [result] = scoreAndRank({
      candidates: [candidate(0.6)],
      // null is a valid "no seeds" signal, equivalent to omitting the field.
      tasteSeeds: null as unknown as undefined,
    })
    expect(result.scoreBreakdown.personalization).toBe(0.5)
  })

  it('throws INVALID_INPUT when tasteSeeds is a present non-array value', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid
      scoreAndRank({ candidates: [candidate(0.6)], tasteSeeds: 'nope' })
    ).toThrow(ScoringError)
  })

  it('applies the documented composite weighting (incl. neutral category affinity)', () => {
    const [result] = scoreAndRank({
      candidates: [candidate(0.8, { tmdbRating: 8, tmdbVoteCount: 5000 })],
    })
    const expected =
      0.8 * SCORE_WEIGHTS.vectorSimilarity +
      0.5 * SCORE_WEIGHTS.personalization + // neutral, no seeds
      0.5 * SCORE_WEIGHTS.categoryAffinity + // neutral, no affinities passed
      result.scoreBreakdown.qualityScore * SCORE_WEIGHTS.qualityScore
    expect(result.score).toBeCloseTo(expected, 5)
  })

  it('exposes a self-describing, auditable breakdown', () => {
    const [result] = scoreAndRank({ candidates: [candidate(0.5)] })
    expect(result.scoreBreakdown.weights).toEqual(DEFAULT_SCORE_WEIGHTS)
    expect(result.scoreBreakdown).toMatchObject({
      vectorSimilarity: expect.any(Number),
      personalization: expect.any(Number),
      categoryAffinity: expect.any(Number),
      qualityScore: expect.any(Number),
    })
  })

  it('sorts by descending score', () => {
    const results = scoreAndRank({
      candidates: [candidate(0.4), candidate(0.9), candidate(0.6)],
    })
    const scores = results.map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('flags confidence using the similarity floor', () => {
    const results = scoreAndRank({
      candidates: [candidate(SIMILARITY_FLOOR + 0.01), candidate(SIMILARITY_FLOOR - 0.01)],
    })
    const byConfidence = Object.fromEntries(results.map((r) => [r.confidence, r]))
    expect(byConfidence.high).toBeDefined()
    expect(byConfidence.low).toBeDefined()
  })

  it('ranks a taste-matched title above an equally-similar unrelated one', () => {
    const loved = seed('loved', { genres: ['Crime'], moodTags: ['dark'] })
    const results = scoreAndRank({
      candidates: [
        candidate(0.6, { id: '00000000-0000-0000-0000-0000000000aa', genres: ['Comedy'] }),
        candidate(0.6, { id: '00000000-0000-0000-0000-0000000000bb', genres: ['Crime'], moodTags: ['dark'] }),
      ],
      tasteSeeds: [loved],
    })
    expect(results[0].content.id).toBe('00000000-0000-0000-0000-0000000000bb')
  })

  it('keeps every score within [0,1]', () => {
    const results = scoreAndRank({
      candidates: [candidate(1.5), candidate(-0.5), candidate(0.5, { tmdbRating: 10, tmdbVoteCount: 99999 })],
    })
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    }
  })

  it('ranks a high-affinity-category title above an equally-similar uncategorized one', () => {
    const affinities = new Map([['sci_fi_fantasy', 0.95]])
    const results = scoreAndRank({
      candidates: [
        candidate(0.6, { id: '00000000-0000-0000-0000-0000000000aa', genres: ['Documentary'] }), // no category → neutral
        candidate(0.6, { id: '00000000-0000-0000-0000-0000000000bb', genres: ['Science Fiction'] }), // sci_fi_fantasy → 0.95
      ],
      categoryAffinities: affinities,
    })
    expect(results[0].content.id).toBe('00000000-0000-0000-0000-0000000000bb')
  })

  it('the kill-switch (weight 0) makes category affinity unable to change the score', () => {
    const affinities = new Map([['sci_fi_fantasy', 0.95]])
    const weights = buildScoreWeights(0)
    const [result] = scoreAndRank({
      candidates: [candidate(0.6, { genres: ['Science Fiction'], tmdbRating: 8, tmdbVoteCount: 5000 })],
      categoryAffinities: affinities,
      weights,
    })
    // The factor is still computed and auditable…
    expect(result.scoreBreakdown.categoryAffinity).toBeCloseTo(0.95, 5)
    // …but with weight 0 it contributes nothing to the score.
    const expected =
      0.6 * weights.vectorSimilarity +
      0.5 * weights.personalization +
      result.scoreBreakdown.qualityScore * weights.qualityScore
    expect(result.score).toBeCloseTo(expected, 5)
  })
})

// ─── computeCategoryAffinity ──────────────────────────────────────────────────

describe('computeCategoryAffinity', () => {
  it('is neutral with no affinities provided', () => {
    expect(computeCategoryAffinity(content({ genres: ['Crime'] }))).toBe(0.5)
    expect(computeCategoryAffinity(content({ genres: ['Crime'] }), new Map())).toBe(0.5)
  })

  it('is neutral for a title in no known category (e.g. pure Documentary)', () => {
    const aff = new Map([['crime_thriller', 0.9]])
    expect(computeCategoryAffinity(content({ genres: ['Documentary'] }), aff)).toBe(0.5)
  })

  it("returns the user's affinity for the title's category", () => {
    const aff = new Map([['crime_thriller', 0.9]])
    expect(computeCategoryAffinity(content({ genres: ['Crime'] }), aff)).toBeCloseTo(0.9, 5)
  })

  it('averages across multiple matching categories', () => {
    const aff = new Map([
      ['crime_thriller', 0.8],
      ['sci_fi_fantasy', 0.4],
    ])
    expect(computeCategoryAffinity(content({ genres: ['Crime', 'Science Fiction'] }), aff)).toBeCloseTo(0.6, 5)
  })

  it('is neutral when the matched category has no affinity entry', () => {
    const aff = new Map([['sci_fi_fantasy', 0.9]])
    expect(computeCategoryAffinity(content({ genres: ['Crime'] }), aff)).toBe(0.5)
  })
})

// ─── weight resolution ────────────────────────────────────────────────────────

describe('buildScoreWeights / getCategoryAffinityWeight', () => {
  it('always sums to 1 for any tunable value', () => {
    for (const w of [0, 0.15, 0.4, 99]) {
      const weights = buildScoreWeights(w)
      const sum =
        weights.vectorSimilarity + weights.personalization + weights.categoryAffinity + weights.qualityScore
      expect(sum).toBeCloseTo(1, 9)
    }
  })

  it('collapses the affinity factor to 0 when disabled, returning its budget to vectorSimilarity', () => {
    const off = buildScoreWeights(0)
    expect(off.categoryAffinity).toBe(0)
    expect(off.vectorSimilarity).toBeCloseTo(0.65, 9)
  })

  it('clamps the tunable to a safe maximum', () => {
    expect(buildScoreWeights(99).categoryAffinity).toBe(0.4)
  })

  it('reads the weight from env with a clamped default', () => {
    expect(getCategoryAffinityWeight({})).toBe(0.15)
    expect(getCategoryAffinityWeight({ SCORE_CATEGORY_AFFINITY_WEIGHT: '0.25' })).toBe(0.25)
    expect(getCategoryAffinityWeight({ SCORE_CATEGORY_AFFINITY_WEIGHT: '99' })).toBe(0.4)
    expect(getCategoryAffinityWeight({ SCORE_CATEGORY_AFFINITY_WEIGHT: 'nope' })).toBe(0.15)
  })
})
