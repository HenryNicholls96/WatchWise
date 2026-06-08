import { describe, expect, it } from 'vitest'
import { mapStreamingType, normalizeShow, parseTmdbId, pickPoster } from '@/lib/sync/catalog/normalize'
import type { MotnShow } from '@/lib/sync/catalog/types'

function show(overrides: Partial<MotnShow> = {}): MotnShow {
  return {
    id: '305914',
    showType: 'movie',
    title: 'Test Title',
    overview: 'A gripping documentary about testing.',
    releaseYear: 2021,
    imdbId: 'tt14045378',
    tmdbId: 'movie/872790',
    genres: [{ id: 'documentary', name: 'Documentary' }],
    cast: ['A Person'],
    directors: ['A Director'],
    rating: 70,
    imageSet: { verticalPoster: { w480: 'https://img/480.jpg', w600: 'https://img/600.jpg' } },
    streamingOptions: {
      gb: [{ service: { id: 'iplayer' }, type: 'free', link: 'https://bbc.co.uk/iplayer/x', availableSince: 1777121409 }],
    },
    ...overrides,
  } as MotnShow
}

describe('parseTmdbId', () => {
  it('parses movie/ and tv/ prefixed ids', () => {
    expect(parseTmdbId('movie/872790')).toEqual({ tmdbId: 872790, type: 'movie' })
    expect(parseTmdbId('tv/136369')).toEqual({ tmdbId: 136369, type: 'series' })
  })
  it('returns nulls for missing/garbage', () => {
    expect(parseTmdbId(undefined)).toEqual({ tmdbId: null, type: null })
    expect(parseTmdbId('weird/abc')).toEqual({ tmdbId: null, type: null })
  })
})

describe('mapStreamingType', () => {
  it('maps known types and folds addon→subscription', () => {
    expect(mapStreamingType('free')).toBe('free')
    expect(mapStreamingType('subscription')).toBe('subscription')
    expect(mapStreamingType('addon')).toBe('subscription')
    expect(mapStreamingType('mystery')).toBeNull()
  })
})

describe('pickPoster', () => {
  it('prefers a mid-size width and falls back', () => {
    expect(pickPoster({ w480: 'a', w600: 'b' })).toBe('a')
    expect(pickPoster({ w720: 'c' })).toBe('c')
    expect(pickPoster(undefined)).toBeNull()
  })
})

describe('normalizeShow', () => {
  it('derives content_key from tmdbId, maps fields, keeps Documentary genre', () => {
    const t = normalizeShow(show(), 'iplayer', 'gb')!
    expect(t.contentKey).toBe('tmdb:872790')
    expect(t.tmdbId).toBe(872790)
    expect(t.type).toBe('movie')
    expect(t.genres).toContain('Documentary')
    expect(t.posterUrl).toBe('https://img/480.jpg')
    expect(t.availability).toHaveLength(1)
    expect(t.availability[0]).toMatchObject({ platformSlug: 'iplayer', region: 'gb', streamingType: 'free' })
  })

  it('uses motn:<id> identity when there is no tmdbId (BBC original)', () => {
    const t = normalizeShow(show({ tmdbId: undefined, showType: 'series' }), 'iplayer', 'gb')!
    expect(t.contentKey).toBe('motn:305914')
    expect(t.tmdbId).toBeNull()
    expect(t.type).toBe('series')
  })

  it('returns null when the platform has no availability in the region', () => {
    expect(normalizeShow(show({ streamingOptions: { gb: [{ service: { id: 'netflix' }, type: 'subscription' }] } }), 'iplayer', 'gb')).toBeNull()
    expect(normalizeShow(show({ streamingOptions: {} }), 'iplayer', 'gb')).toBeNull()
  })
})
