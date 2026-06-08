import { describe, expect, it } from 'vitest'
import { qualityGate } from '@/lib/sync/catalog/validate'
import type { IngestedTitle } from '@/lib/sync/catalog/types'

function title(overrides: Partial<IngestedTitle> = {}): IngestedTitle {
  return {
    contentKey: 'motn:1',
    motnId: '1',
    tmdbId: null,
    imdbId: null,
    type: 'movie',
    title: 'A Title',
    releaseYear: 2020,
    description: 'A real synopsis.',
    genres: ['Drama'],
    castNames: [],
    directorNames: [],
    runtimeMinutes: null,
    seasonCount: null,
    posterUrl: 'https://img/p.jpg',
    backdropUrl: null,
    motnRating: null,
    availability: [{ platformSlug: 'iplayer', region: 'gb', deepLink: 'https://bbc/x', streamingType: 'free', availableFrom: null, availableUntil: null }],
    ...overrides,
  }
}

describe('qualityGate', () => {
  it('passes a complete, linkable title', () => {
    expect(qualityGate(title())).toEqual({ ok: true })
  })
  it('rejects missing genres / description / poster with a specific reason', () => {
    expect(qualityGate(title({ genres: [] }))).toEqual({ ok: false, reason: 'no_genres' })
    expect(qualityGate(title({ description: null }))).toEqual({ ok: false, reason: 'missing_description' })
    expect(qualityGate(title({ posterUrl: null }))).toEqual({ ok: false, reason: 'missing_poster' })
  })
  it('rejects a title with no linkable availability', () => {
    expect(qualityGate(title({ availability: [{ platformSlug: 'iplayer', region: 'gb', deepLink: null, streamingType: 'free', availableFrom: null, availableUntil: null }] }))).toEqual({
      ok: false,
      reason: 'no_active_availability',
    })
  })
})
