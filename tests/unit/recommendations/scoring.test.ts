import { describe, expect, it } from 'vitest'
import type { Candidate, ContentRow } from '@/lib/types/content'
import type { TasteSeed } from '@/lib/types/taste'
import {
  SCORE_WEIGHTS,
  SIMILARITY_FLOOR,
  ScoringError,
  computePersonalization,
  computeQualityScore,
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

  it('applies the documented composite weighting', () => {
    const [result] = scoreAndRank({
      candidates: [candidate(0.8, { tmdbRating: 8, tmdbVoteCount: 5000 })],
    })
    const expected =
      0.8 * SCORE_WEIGHTS.vectorSimilarity +
      0.5 * SCORE_WEIGHTS.personalization + // neutral, no seeds
      result.scoreBreakdown.qualityScore * SCORE_WEIGHTS.qualityScore
    expect(result.score).toBeCloseTo(expected, 5)
  })

  it('exposes a self-describing, auditable breakdown', () => {
    const [result] = scoreAndRank({ candidates: [candidate(0.5)] })
    expect(result.scoreBreakdown.weights).toEqual(SCORE_WEIGHTS)
    expect(result.scoreBreakdown).toMatchObject({
      vectorSimilarity: expect.any(Number),
      personalization: expect.any(Number),
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
})
