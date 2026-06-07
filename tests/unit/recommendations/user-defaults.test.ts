import { describe, expect, it } from 'vitest'
import { profileToDefaults } from '@/lib/recommendations/user-defaults'

describe('profileToDefaults', () => {
  it('returns empty defaults for an empty/blank profile', () => {
    expect(profileToDefaults({})).toEqual({})
    expect(profileToDefaults({ preferred_platforms: [], preferences: {} })).toEqual({})
  })

  it('maps preferred_platforms to a default platform allow-set', () => {
    expect(profileToDefaults({ preferred_platforms: ['netflix', 'prime'] }).platformSlugs).toEqual(['netflix', 'prime'])
  })

  it('maps mediaType movie/series to contentType', () => {
    expect(profileToDefaults({ preferences: { mediaType: 'movie' } }).contentType).toBe('movie')
    expect(profileToDefaults({ preferences: { mediaType: 'series' } }).contentType).toBe('series')
  })

  it('maps mediaType "documentary" to a required Documentary genre, with no contentType', () => {
    const d = profileToDefaults({ preferences: { mediaType: 'documentary' } })
    expect(d.requireGenres).toEqual(['Documentary'])
    expect(d.contentType).toBeUndefined()
  })

  it('maps mediaType "all" to no restriction at all', () => {
    const d = profileToDefaults({ preferences: { mediaType: 'all' } })
    expect(d.contentType).toBeUndefined()
    expect(d.requireGenres).toBeUndefined()
  })

  it('mediaType "all" overrides any legacy contentType (no fallback)', () => {
    const d = profileToDefaults({ preferences: { mediaType: 'all', contentType: 'series' } })
    expect(d.contentType).toBeUndefined()
  })

  it('falls back to a legacy contentType when no mediaType is stored (back-compat)', () => {
    expect(profileToDefaults({ preferences: { contentType: 'movie' } }).contentType).toBe('movie')
    expect(profileToDefaults({ preferences: { contentType: 'series' } }).contentType).toBe('series')
    expect(profileToDefaults({ preferences: { contentType: 'any' } }).contentType).toBeUndefined()
  })

  it('maps runtime to a minutes cap (movie/any → no cap)', () => {
    expect(profileToDefaults({ preferences: { runtime: 'short' } }).maxRuntimeMinutes).toBe(45)
    expect(profileToDefaults({ preferences: { runtime: 'hour' } }).maxRuntimeMinutes).toBe(90)
    expect(profileToDefaults({ preferences: { runtime: 'movie' } }).maxRuntimeMinutes).toBeUndefined()
    expect(profileToDefaults({ preferences: { runtime: 'any' } }).maxRuntimeMinutes).toBeUndefined()
  })

  it('maps avoidGenres to default genre exclusions', () => {
    expect(profileToDefaults({ preferences: { avoidGenres: ['Horror', 'Reality'] } }).excludeGenres).toEqual([
      'Horror',
      'Reality',
    ])
  })

  it('combines all answers', () => {
    const d = profileToDefaults({
      preferred_platforms: ['disney'],
      preferences: { contentType: 'series', runtime: 'hour', avoidGenres: ['Horror'] },
    })
    expect(d).toEqual({
      platformSlugs: ['disney'],
      contentType: 'series',
      maxRuntimeMinutes: 90,
      excludeGenres: ['Horror'],
    })
  })

  it('is tolerant of malformed data', () => {
    expect(profileToDefaults({ preferred_platforms: 'netflix', preferences: null })).toEqual({})
    expect(profileToDefaults({ preferences: { avoidGenres: 'Horror' } }).excludeGenres).toBeUndefined()
  })
})
