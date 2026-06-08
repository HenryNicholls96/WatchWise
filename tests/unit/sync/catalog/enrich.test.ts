import { describe, expect, it, vi } from 'vitest'
import { enrichTitle } from '@/lib/sync/catalog/enrich'
import type { OmdbRatings } from '@/lib/sync/omdb-client'
import type { IngestedTitle } from '@/lib/sync/catalog/types'

function title(over: Partial<IngestedTitle> = {}): IngestedTitle {
  return {
    contentKey: 'motn:1',
    motnId: '1',
    tmdbId: null,
    imdbId: null,
    type: 'movie',
    title: 'T',
    releaseYear: 2020,
    description: null,
    genres: ['Drama'],
    castNames: [],
    directorNames: [],
    runtimeMinutes: null,
    seasonCount: null,
    posterUrl: 'p',
    backdropUrl: null,
    motnRating: null,
    availability: [],
    ...over,
  }
}

const omdbFound = (plot: string | null): OmdbRatings => ({ found: true, imdbRating: 8, imdbVotes: 1000, metascore: 70, plot })

describe('enrichTitle — description backfill', () => {
  it('keeps the motn synopsis when present (no external fetch)', async () => {
    const getTmdbOverview = vi.fn()
    const out = await enrichTitle(title({ description: 'From motn.' }), { tagMappings: [], getTmdbOverview })
    expect(out.descriptionSource).toBe('motn')
    expect(out.description).toBe('From motn.')
    expect(getTmdbOverview).not.toHaveBeenCalled()
  })

  it('backfills from TMDb when motn has none and a tmdbId exists', async () => {
    const out = await enrichTitle(title({ tmdbId: 555 }), {
      tagMappings: [],
      getTmdbOverview: vi.fn().mockResolvedValue('From TMDb.'),
    })
    expect(out.descriptionSource).toBe('tmdb')
    expect(out.description).toBe('From TMDb.')
  })

  it('falls back to the OMDb plot when there is no tmdbId but an imdbId', async () => {
    const out = await enrichTitle(title({ imdbId: 'tt1' }), {
      tagMappings: [],
      getOmdb: vi.fn().mockResolvedValue(omdbFound('From OMDb.')),
    })
    expect(out.descriptionSource).toBe('omdb')
    expect(out.description).toBe('From OMDb.')
    expect(out.blendedRating).not.toBeNull() // single OMDb call also yields the rating
  })

  it('prefers TMDb over OMDb when both could supply a description', async () => {
    const out = await enrichTitle(title({ tmdbId: 555, imdbId: 'tt1' }), {
      tagMappings: [],
      getTmdbOverview: vi.fn().mockResolvedValue('From TMDb.'),
      getOmdb: vi.fn().mockResolvedValue(omdbFound('From OMDb.')),
    })
    expect(out.descriptionSource).toBe('tmdb')
  })

  it('reports "none" (→ will be skipped) when nothing supplies a description', async () => {
    const out = await enrichTitle(title({ tmdbId: 555 }), {
      tagMappings: [],
      getTmdbOverview: vi.fn().mockResolvedValue(null),
    })
    expect(out.descriptionSource).toBe('none')
    expect(out.description).toBeNull()
  })
})
