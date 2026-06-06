import { describe, expect, it } from 'vitest'
import { calculateBlendedRating } from '@/lib/sync/blended-rating'

describe('calculateBlendedRating', () => {
  it('blends all three sources with the documented weights', () => {
    // imdb 8→80 (0.45), metacritic 90 (0.35), tmdb 7→70 (0.20) → 36 + 31.5 + 14 = 81.5
    const r = calculateBlendedRating({ imdb: { rating: 8 }, metacritic: 90, tmdb: { rating: 7 } })
    expect(r.blendedRating).toBe(81.5)
    expect(r.contributing).toEqual(['imdb', 'metacritic', 'tmdb'])
  })

  it('re-normalizes weights when a source is missing', () => {
    // imdb 8→80 (0.45), tmdb 7→70 (0.20); totalWeight 0.65 → (36 + 14) / 0.65 = 76.92 → 76.9
    const r = calculateBlendedRating({ imdb: { rating: 8 }, tmdb: { rating: 7 } })
    expect(r.blendedRating).toBeCloseTo(76.9, 1)
    expect(r.contributing).toEqual(['imdb', 'tmdb'])
  })

  it('falls back to a single source', () => {
    const r = calculateBlendedRating({ tmdb: { rating: 8.3, votes: 5000 } })
    expect(r.blendedRating).toBe(83)
    expect(r.contributing).toEqual(['tmdb'])
  })

  it('returns null when no source is usable', () => {
    expect(calculateBlendedRating({})).toEqual({ blendedRating: null, contributing: [] })
    expect(calculateBlendedRating({ imdb: null, metacritic: null, tmdb: null }).blendedRating).toBeNull()
  })

  it('ignores non-finite / out-of-shape values', () => {
    const r = calculateBlendedRating({ imdb: { rating: NaN }, metacritic: 75, tmdb: { rating: 8 } })
    expect(r.contributing).toEqual(['metacritic', 'tmdb'])
  })

  it('clamps source values into range', () => {
    // imdb 11→clamp 100, metacritic -5→clamp 0
    const r = calculateBlendedRating({ imdb: { rating: 11 }, metacritic: -5 })
    // (100*0.45 + 0*0.35) / 0.8 = 45 / 0.8 = 56.25 → 56.3
    expect(r.blendedRating).toBe(56.3)
  })
})
