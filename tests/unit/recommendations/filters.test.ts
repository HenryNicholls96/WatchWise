import { describe, expect, it } from 'vitest'
import type { Candidate, ContentRow } from '@/lib/types/content'
import { filterByExcludedGenres, filterByLanguage, filterByRequiredGenres } from '@/lib/recommendations/filters'

function candidate(overrides: Partial<ContentRow> = {}): Candidate {
  return {
    vectorSimilarity: 0.6,
    content: {
      id: crypto.randomUUID(),
      tmdbId: 1,
      title: 'X',
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
    },
  }
}

describe('filterByExcludedGenres', () => {
  it('is a no-op when no exclusions are given', () => {
    const cands = [candidate({ genres: ['Horror'] })]
    expect(filterByExcludedGenres(cands, undefined)).toBe(cands)
    expect(filterByExcludedGenres(cands, [])).toBe(cands)
  })

  it('drops candidates whose genre matches an excluded term (case-insensitive)', () => {
    const horror = candidate({ genres: ['Horror', 'Thriller'] })
    const drama = candidate({ genres: ['Drama'] })
    const out = filterByExcludedGenres([horror, drama], ['Horror'])
    expect(out).toEqual([drama])
  })

  it('also matches against mood/theme tags, not just genres', () => {
    const tagged = candidate({ genres: ['Thriller'], themeTags: ['horror'] })
    const clean = candidate({ genres: ['Thriller'], themeTags: ['heist'] })
    const out = filterByExcludedGenres([tagged, clean], ['horror'])
    expect(out).toEqual([clean])
  })

  it('keeps titles with no genres/tags (fail-open)', () => {
    const bare = candidate({ genres: [], moodTags: [], themeTags: [] })
    expect(filterByExcludedGenres([bare], ['Horror'])).toEqual([bare])
  })

  it('excludes a candidate if it matches ANY excluded term', () => {
    const scifi = candidate({ genres: ['Sci-Fi & Fantasy'] })
    const drama = candidate({ genres: ['Drama'] })
    const out = filterByExcludedGenres([scifi, drama], ['Science Fiction', 'Sci-Fi & Fantasy'])
    expect(out).toEqual([drama])
  })

  it('keeps a protected (liked) title even if it matches an excluded genre', () => {
    const likedHorror = candidate({ id: '00000000-0000-0000-0000-0000000000aa', genres: ['Horror'] })
    const otherHorror = candidate({ id: '00000000-0000-0000-0000-0000000000bb', genres: ['Horror'] })
    const out = filterByExcludedGenres([likedHorror, otherHorror], ['Horror'], [likedHorror.content.id])
    expect(out).toEqual([likedHorror])
  })
})

describe('filterByRequiredGenres', () => {
  it('is a no-op when no required genres are given', () => {
    const cands = [candidate({ genres: ['Drama'] })]
    expect(filterByRequiredGenres(cands, undefined)).toBe(cands)
    expect(filterByRequiredGenres(cands, [])).toBe(cands)
  })

  it('keeps only candidates that include a required genre (case-insensitive)', () => {
    const doc = candidate({ genres: ['Documentary', 'History'] })
    const docCase = candidate({ genres: ['documentary'] })
    const drama = candidate({ genres: ['Drama'] })
    const out = filterByRequiredGenres([doc, docCase, drama], ['Documentary'])
    expect(out).toEqual([doc, docCase])
  })

  it('DROPS titles with no matching genre — an inclusion gate, not fail-open', () => {
    const bare = candidate({ genres: [] })
    expect(filterByRequiredGenres([bare], ['Documentary'])).toEqual([])
  })
})

describe('filterByLanguage', () => {
  it('is a no-op when no language is given', () => {
    const cands = [candidate({ originalLanguage: 'de' })]
    expect(filterByLanguage(cands, undefined)).toBe(cands)
  })

  it('keeps only matching-language titles (case-insensitive)', () => {
    const en = candidate({ originalLanguage: 'en' })
    const de = candidate({ originalLanguage: 'DE' })
    expect(filterByLanguage([en, de], 'en')).toEqual([en])
  })

  it('keeps titles with no language metadata (fail-open)', () => {
    const unknown = candidate({ originalLanguage: null })
    expect(filterByLanguage([unknown], 'en')).toEqual([unknown])
  })
})
