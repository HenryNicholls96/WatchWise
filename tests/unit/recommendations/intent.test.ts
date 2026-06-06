import { describe, expect, it } from 'vitest'
import { PLATFORM_SLUGS, parseQueryConstraints } from '@/lib/recommendations/intent'

describe('parseQueryConstraints — platform negatives', () => {
  it('extracts "not on Disney" and strips it from the query', () => {
    const r = parseQueryConstraints('dark thriller not on disney')
    expect(r.excludePlatforms).toEqual(['disney'])
    expect(r.excludeGenres).toEqual([])
    expect(r.cleanedQuery).toBe('dark thriller')
  })

  it('handles platform aliases (amazon prime video → prime)', () => {
    expect(parseQueryConstraints('comedy not on amazon prime video').excludePlatforms).toEqual(['prime'])
    expect(parseQueryConstraints('comedy without netflix').excludePlatforms).toEqual(['netflix'])
  })

  it('handles "disney+" with punctuation', () => {
    const r = parseQueryConstraints('something fun, not on disney+')
    expect(r.excludePlatforms).toEqual(['disney'])
  })

  it('is case-insensitive', () => {
    expect(parseQueryConstraints('Dark Thriller NOT ON NETFLIX').excludePlatforms).toEqual(['netflix'])
  })
})

describe('parseQueryConstraints — genre negatives', () => {
  it('extracts "without horror"', () => {
    const r = parseQueryConstraints('feel-good comedy without horror')
    expect(r.excludeGenres).toEqual(['Horror'])
    expect(r.cleanedQuery).toBe('feel-good comedy')
  })

  it('resolves "no sci-fi" to both movie and TV canonical genres', () => {
    const r = parseQueryConstraints('thriller no sci-fi')
    expect(r.excludeGenres).toEqual(expect.arrayContaining(['Science Fiction', 'Sci-Fi & Fantasy']))
    expect(r.cleanedQuery).toBe('thriller')
  })

  it('matches multi-word genres ("science fiction", "action & adventure")', () => {
    expect(parseQueryConstraints('drama without science fiction').excludeGenres).toEqual(
      expect.arrayContaining(['Science Fiction', 'Sci-Fi & Fantasy'])
    )
    expect(parseQueryConstraints('not action & adventure please').excludeGenres).toContain('Action & Adventure')
  })

  it('handles the "no more X" cue', () => {
    expect(parseQueryConstraints('something light, no more horror').excludeGenres).toEqual(['Horror'])
  })
})

describe('parseQueryConstraints — combined and dedup', () => {
  it('extracts platform AND genre negatives together', () => {
    const r = parseQueryConstraints('comedy not on disney without horror')
    expect(r.excludePlatforms).toEqual(['disney'])
    expect(r.excludeGenres).toEqual(['Horror'])
    expect(r.cleanedQuery).toBe('comedy')
  })

  it('dedupes repeated exclusions', () => {
    const r = parseQueryConstraints('no horror without horror please')
    expect(r.excludeGenres).toEqual(['Horror'])
  })
})

describe('parseQueryConstraints — fail-open & scope', () => {
  it('does not strip unrelated positive terms', () => {
    const r = parseQueryConstraints('dark psychological thriller not on disney')
    expect(r.cleanedQuery).toBe('dark psychological thriller')
  })

  it('ignores a negation cue followed by an unknown term (leaves query intact)', () => {
    const r = parseQueryConstraints('a story without subtitles')
    expect(r.excludePlatforms).toEqual([])
    expect(r.excludeGenres).toEqual([])
    expect(r.cleanedQuery).toBe('a story without subtitles')
  })

  it('does not false-trigger on titles containing cue words ("No Country for Old Men")', () => {
    const r = parseQueryConstraints('something like no country for old men')
    expect(r.excludePlatforms).toEqual([])
    expect(r.excludeGenres).toEqual([])
    expect(r.cleanedQuery).toBe('something like no country for old men')
  })

  it('does not exclude a genre mentioned positively (no cue)', () => {
    const r = parseQueryConstraints('a great horror movie on netflix')
    expect(r.excludeGenres).toEqual([])
    expect(r.excludePlatforms).toEqual([])
  })

  it('returns empty cleanedQuery when the whole query is a negation (engine falls back to raw)', () => {
    const r = parseQueryConstraints('no horror')
    expect(r.excludeGenres).toEqual(['Horror'])
    expect(r.cleanedQuery).toBe('')
  })

  it('handles empty / whitespace input', () => {
    expect(parseQueryConstraints('')).toEqual({
      cleanedQuery: '',
      excludePlatforms: [],
      excludeGenres: [],
      includePlatforms: [],
    })
    expect(parseQueryConstraints('   ').cleanedQuery).toBe('')
  })
})

describe('parseQueryConstraints — positive: content type', () => {
  it('extracts "only movies"', () => {
    const r = parseQueryConstraints('only movies')
    expect(r.contentType).toBe('movie')
    expect(r.cleanedQuery).toBe('')
  })

  it('extracts bare type nouns and strips them', () => {
    const r = parseQueryConstraints('funny movies')
    expect(r.contentType).toBe('movie')
    expect(r.cleanedQuery).toBe('funny')
  })

  it('recognizes "tv shows" as series', () => {
    expect(parseQueryConstraints('gritty tv shows').contentType).toBe('series')
    expect(parseQueryConstraints('just series').contentType).toBe('series')
  })

  it('does not treat singular "show" (as in "show me") as a content type', () => {
    const r = parseQueryConstraints('show me a thriller')
    expect(r.contentType).toBeUndefined()
  })

  it('leaves content type undefined when ambiguous', () => {
    expect(parseQueryConstraints('movies and shows about space').contentType).toBeUndefined()
  })
})

describe('parseQueryConstraints — positive: platform', () => {
  it('extracts "on Netflix"', () => {
    const r = parseQueryConstraints('comedy on netflix')
    expect(r.includePlatforms).toEqual(['netflix'])
    expect(r.cleanedQuery).toBe('comedy')
  })

  it('handles "only on disney" and "streaming on prime"', () => {
    expect(parseQueryConstraints('cartoons only on disney').includePlatforms).toEqual(['disney'])
    expect(parseQueryConstraints('thrillers streaming on prime').includePlatforms).toEqual(['prime'])
  })

  it('does not false-trigger on "based on a true story"', () => {
    const r = parseQueryConstraints('a film based on a true story')
    expect(r.includePlatforms).toEqual([])
  })
})

describe('parseQueryConstraints — positive: runtime', () => {
  it('parses "under 2 hours" → 120', () => {
    const r = parseQueryConstraints('action under 2 hours')
    expect(r.maxRuntimeMinutes).toBe(120)
    expect(r.cleanedQuery).toBe('action')
  })

  it('parses "less than 90 minutes" and "no more than 1 hour"', () => {
    expect(parseQueryConstraints('docs less than 90 minutes').maxRuntimeMinutes).toBe(90)
    expect(parseQueryConstraints('something no more than 1 hour').maxRuntimeMinutes).toBe(60)
  })

  it('requires a comparator (does not misfire on a bare number + unit)', () => {
    expect(parseQueryConstraints('2 hours of comedy').maxRuntimeMinutes).toBeUndefined()
  })
})

describe('parseQueryConstraints — positive: language', () => {
  it('parses "in English" → en', () => {
    const r = parseQueryConstraints('a tense thriller in english')
    expect(r.originalLanguage).toBe('en')
    expect(r.cleanedQuery).toBe('a tense thriller')
  })

  it('maps language names to ISO codes', () => {
    expect(parseQueryConstraints('drama in korean').originalLanguage).toBe('ko')
    expect(parseQueryConstraints('films in spanish').originalLanguage).toBe('es')
  })
})

describe('parseQueryConstraints — combined positives + negatives', () => {
  it('extracts a rich mixed query', () => {
    const r = parseQueryConstraints('only series on netflix under 30 minutes not on disney without horror in english')
    expect(r.contentType).toBe('series')
    expect(r.includePlatforms).toEqual(['netflix'])
    expect(r.excludePlatforms).toEqual(['disney'])
    expect(r.maxRuntimeMinutes).toBe(30)
    expect(r.originalLanguage).toBe('en')
    expect(r.excludeGenres).toEqual(['Horror'])
  })
})

describe('PLATFORM_SLUGS', () => {
  it('contains the three carried platforms', () => {
    expect([...PLATFORM_SLUGS]).toEqual(['netflix', 'prime', 'disney'])
  })
})
