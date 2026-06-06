import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentRow } from '@/lib/types/content'
import type { TasteSeed } from '@/lib/types/taste'
import { CircuitBreaker, claudeBreaker } from '@/lib/utils/circuit-breaker'
import { InMemoryStore } from '@/lib/utils/distributed-store'
import { SCORE_WEIGHTS, type ScoredCandidate } from '@/lib/recommendations/scoring'
import {
  type ExplanationClient,
  ExplanationError,
  buildFallbackExplanation,
  buildPromptItem,
  createInMemoryExplanationCache,
  explanationCacheKey,
  generateExplanations,
  hashQuery,
  isLowConfidence,
  summarizeSignals,
  tasteSignature,
} from '@/lib/recommendations/explanations'

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

type ResultOverrides = {
  content?: Partial<ContentRow>
  vectorSimilarity?: number
  personalization?: number
  qualityScore?: number
  confidence?: 'high' | 'low'
}

function makeResult(o: ResultOverrides = {}): ScoredCandidate {
  const vectorSimilarity = o.vectorSimilarity ?? 0.7
  const personalization = o.personalization ?? 0.5
  const qualityScore = o.qualityScore ?? 0.5
  return {
    content: content(o.content),
    score: 0.5,
    confidence: o.confidence ?? (vectorSimilarity >= 0.55 ? 'high' : 'low'),
    scoreBreakdown: { vectorSimilarity, personalization, qualityScore, weights: SCORE_WEIGHTS },
  }
}

function seed(sentiment: TasteSeed['sentiment'], overrides: Partial<ContentRow> = {}): TasteSeed {
  return { sentiment, content: content(overrides) }
}

function fakeClient(behavior: (items: { contentId: string }[]) => Map<string, string>): ExplanationClient & { calls: number } {
  const client = {
    calls: 0,
    async generate(items: { contentId: string }[]) {
      client.calls++
      return behavior(items)
    },
  }
  return client as ExplanationClient & { calls: number }
}

// Reset the shared Claude breaker before each test so singleton state can't leak between cases
// (tests that don't inject their own breaker use the default claudeBreaker).
beforeEach(() => claudeBreaker.reset())

// ─── hashQuery ──────────────────────────────────────────────────────────────

describe('hashQuery', () => {
  it('is deterministic', () => {
    expect(hashQuery('dark crime drama')).toBe(hashQuery('dark crime drama'))
  })

  it('normalizes case and whitespace', () => {
    expect(hashQuery('  Dark   Crime Drama ')).toBe(hashQuery('dark crime drama'))
  })

  it('differs for different queries', () => {
    expect(hashQuery('feel good comedy')).not.toBe(hashQuery('dark crime drama'))
  })

  it('produces a 64-char hex SHA-256', () => {
    expect(hashQuery('anything')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('explanationCacheKey', () => {
  it('combines content id and query hash when there is no taste signature', () => {
    expect(explanationCacheKey('abc', 'def')).toBe('abc:def')
  })

  it('appends the taste signature when present', () => {
    expect(explanationCacheKey('abc', 'def', 'sig123')).toBe('abc:def:sig123')
  })
})

describe('tasteSignature', () => {
  it('is empty for no seeds (explanations are then user-agnostic)', () => {
    expect(tasteSignature([])).toBe('')
  })

  it('is order-independent', () => {
    const a = seed('loved', { id: 'id-1' })
    const b = seed('disliked', { id: 'id-2' })
    expect(tasteSignature([a, b])).toBe(tasteSignature([b, a]))
  })

  it('differs when seeds or sentiments differ', () => {
    const base = [seed('loved', { id: 'id-1' })]
    expect(tasteSignature(base)).not.toBe(tasteSignature([seed('disliked', { id: 'id-1' })]))
    expect(tasteSignature(base)).not.toBe(tasteSignature([seed('loved', { id: 'id-2' })]))
  })
})

// ─── isLowConfidence ──────────────────────────────────────────────────────────

describe('isLowConfidence', () => {
  it('is true below the similarity floor', () => {
    expect(isLowConfidence(makeResult({ vectorSimilarity: 0.4 }))).toBe(true)
  })
  it('is false at or above the floor', () => {
    expect(isLowConfidence(makeResult({ vectorSimilarity: 0.6 }))).toBe(false)
  })
})

// ─── summarizeSignals ─────────────────────────────────────────────────────────

describe('summarizeSignals', () => {
  it('bands semantic match by similarity', () => {
    expect(summarizeSignals(makeResult({ vectorSimilarity: 0.7 }), []).semanticMatch).toBe('strong')
    expect(summarizeSignals(makeResult({ vectorSimilarity: 0.6 }), []).semanticMatch).toBe('solid')
    expect(summarizeSignals(makeResult({ vectorSimilarity: 0.4 }), []).semanticMatch).toBe('loose')
  })

  it('bands quality by quality score', () => {
    expect(summarizeSignals(makeResult({ qualityScore: 0.8 }), []).quality).toBe('acclaimed')
    expect(summarizeSignals(makeResult({ qualityScore: 0.5 }), []).quality).toBe('well-reviewed')
    expect(summarizeSignals(makeResult({ qualityScore: 0.1 }), []).quality).toBe('unknown')
  })

  it('names the responsible seed when personalization is above neutral', () => {
    const result = makeResult({
      personalization: 0.8,
      content: { genres: ['Crime', 'Drama'], moodTags: ['dark'] },
    })
    const seeds = [seed('loved', { title: 'Ozark', genres: ['Crime'] })]
    const affinity = summarizeSignals(result, seeds).affinity
    expect(affinity?.seedTitle).toBe('Ozark')
    expect(affinity?.sentiment).toBe('loved')
    expect(affinity?.sharedTags.map((t) => t.toLowerCase())).toContain('crime')
  })

  it('omits affinity when personalization is only neutral', () => {
    const result = makeResult({ personalization: 0.5, content: { genres: ['Crime'] } })
    const seeds = [seed('loved', { title: 'Ozark', genres: ['Crime'] })]
    expect(summarizeSignals(result, seeds).affinity).toBeUndefined()
  })

  it('omits affinity when no positive seed overlaps the candidate', () => {
    const result = makeResult({ personalization: 0.8, content: { genres: ['Crime'] } })
    const seeds = [seed('loved', { title: 'Friends', genres: ['Comedy'] })]
    expect(summarizeSignals(result, seeds).affinity).toBeUndefined()
  })

  it('never names a disliked seed', () => {
    const result = makeResult({ personalization: 0.8, content: { genres: ['Crime'] } })
    const seeds = [seed('disliked', { title: 'Hated Show', genres: ['Crime'] })]
    expect(summarizeSignals(result, seeds).affinity).toBeUndefined()
  })
})

// ─── buildPromptItem ──────────────────────────────────────────────────────────

describe('buildPromptItem', () => {
  it('carries identity and signals', () => {
    const item = buildPromptItem(makeResult({ content: { id: 'x1', title: 'Dark' } }), [])
    expect(item.contentId).toBe('x1')
    expect(item.title).toBe('Dark')
    expect(item.signals).toBeDefined()
  })

  it('truncates long descriptions with an ellipsis', () => {
    const long = 'a'.repeat(400)
    const item = buildPromptItem(makeResult({ content: { description: long } }), [])
    expect(item.descriptionExcerpt!.length).toBeLessThan(long.length)
    expect(item.descriptionExcerpt!.endsWith('…')).toBe(true)
  })
})

// ─── buildFallbackExplanation ─────────────────────────────────────────────────

describe('buildFallbackExplanation', () => {
  it('hedges honestly for low-confidence results', () => {
    const item = buildPromptItem(makeResult({ confidence: 'low', vectorSimilarity: 0.4 }), [])
    const text = buildFallbackExplanation(item)
    expect(text.toLowerCase()).toContain('outside your search')
  })

  it('references the responsible seed when there is taste affinity', () => {
    const result = makeResult({
      personalization: 0.8,
      content: { title: 'Ozark', genres: ['Crime', 'Drama'], moodTags: ['dark'] },
    })
    const seeds = [seed('loved', { title: 'Breaking Bad', genres: ['Crime'], moodTags: ['dark'] })]
    const text = buildFallbackExplanation(buildPromptItem(result, seeds))
    expect(text).toContain('Breaking Bad')
    expect(text.toLowerCase()).toContain('loved')
  })

  it('falls back to a confident match line with no taste signal', () => {
    const item = buildPromptItem(makeResult({ vectorSimilarity: 0.7, qualityScore: 0.8, content: { genres: ['Thriller'] } }), [])
    const text = buildFallbackExplanation(item)
    expect(text.toLowerCase()).toContain('strong match')
    expect(text.toLowerCase()).toContain('acclaimed')
  })
})

// ─── generateExplanations ─────────────────────────────────────────────────────

describe('generateExplanations', () => {
  it('throws INVALID_INPUT when results is not an array', async () => {
    // @ts-expect-error deliberately invalid
    await expect(generateExplanations({ results: null, queryText: 'x' })).rejects.toThrow(ExplanationError)
  })

  it('throws INVALID_INPUT on empty query', async () => {
    await expect(generateExplanations({ results: [makeResult()], queryText: '  ' })).rejects.toThrow(ExplanationError)
  })

  it('returns an empty result set for no results', async () => {
    const { results, stats } = await generateExplanations({ results: [], queryText: 'x' })
    expect(results).toEqual([])
    expect(stats).toMatchObject({ total: 0, cacheHits: 0, cacheMisses: 0, llmUsed: false, fallbackCount: 0 })
  })

  it('attaches deterministic fallbacks when no client is provided', async () => {
    const results = [makeResult({ content: { id: 'a' } }), makeResult({ content: { id: 'b' } })]
    const { results: out, stats } = await generateExplanations({ results, queryText: 'dark crime' })
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.explanation.length > 0)).toBe(true)
    expect(stats).toMatchObject({ total: 2, cacheHits: 0, cacheMisses: 2, llmUsed: false, fallbackCount: 2 })
  })

  it('preserves input order', async () => {
    const results = [
      makeResult({ content: { id: 'a', title: 'A' } }),
      makeResult({ content: { id: 'b', title: 'B' } }),
      makeResult({ content: { id: 'c', title: 'C' } }),
    ]
    const { results: out } = await generateExplanations({ results, queryText: 'q' })
    expect(out.map((r) => r.content.id)).toEqual(['a', 'b', 'c'])
  })

  it('uses LLM explanations when the client returns them', async () => {
    const client = fakeClient((items) => new Map(items.map((i) => [i.contentId, `LLM: ${i.contentId}`])))
    const { results: out, stats } = await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } })], queryText: 'q' },
      { client }
    )
    expect(out[0].explanation).toBe('LLM: a')
    expect(client.calls).toBe(1)
    expect(stats).toMatchObject({ cacheHits: 0, cacheMisses: 1, llmUsed: true, fallbackCount: 0 })
  })

  it('falls back for any items the client omits', async () => {
    const client = fakeClient(() => new Map([['a', 'LLM: a']])) // returns only 'a'
    const { results: out, stats } = await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } }), makeResult({ content: { id: 'b' } })], queryText: 'q' },
      { client }
    )
    const byId = Object.fromEntries(out.map((r) => [r.content.id, r.explanation]))
    expect(byId.a).toBe('LLM: a')
    expect(byId.b.length).toBeGreaterThan(0)
    expect(byId.b).not.toContain('LLM')
    expect(stats).toMatchObject({ cacheMisses: 2, llmUsed: true, fallbackCount: 1 })
  })

  it('degrades to fallbacks (no throw) when the client fails', async () => {
    const client: ExplanationClient = {
      generate: vi.fn().mockRejectedValue(new Error('haiku down')),
    }
    const { results: out, stats } = await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } })], queryText: 'q' },
      { client }
    )
    expect(out[0].explanation.length).toBeGreaterThan(0)
    expect(stats).toMatchObject({ llmUsed: true, fallbackCount: 1, llmError: true, deadlineHit: false })
  })

  it('falls back to deterministic explanations when the LLM exceeds the deadline (counted in fallbackCount)', async () => {
    vi.useFakeTimers()
    try {
      const neverResolves: ExplanationClient = { generate: () => new Promise(() => {}) } // hangs forever
      const promise = generateExplanations(
        { results: [makeResult({ content: { id: 'a' } }), makeResult({ content: { id: 'b' } })], queryText: 'q' },
        { client: neverResolves }
      )
      await vi.advanceTimersByTimeAsync(3000) // trip the deadline
      const { results: out, stats } = await promise

      expect(out).toHaveLength(2)
      expect(out.every((r) => r.explanation.length > 0)).toBe(true) // every item still has a (fallback) explanation
      expect(stats).toMatchObject({ cacheMisses: 2, llmUsed: true, fallbackCount: 2, deadlineHit: true, llmError: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts transient LLM retries reported by the client (resilience signal)', async () => {
    const client: ExplanationClient = {
      generate: async (_items, _ctx, _signal, onRetry) => {
        onRetry?.()
        onRetry?.()
        return new Map([['a', 'LLM: a']])
      },
    }
    const { stats } = await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } })], queryText: 'q' },
      { client }
    )
    expect(stats).toMatchObject({ llmUsed: true, llmRetries: 2, llmError: false, deadlineHit: false, fallbackCount: 0 })
  })

  it('skips the LLM and falls back deterministically when the Claude breaker is open', async () => {
    const breaker = new CircuitBreaker({ name: 'claude-test', failureThreshold: 1, cooldownMs: 60_000, now: () => 0, store: new InMemoryStore() })
    await breaker.recordFailure() // → open
    const client = fakeClient((items) => new Map(items.map((i) => [i.contentId, `LLM: ${i.contentId}`])))

    const { results: out, stats } = await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } })], queryText: 'q' },
      { client, breaker }
    )

    expect(client.calls).toBe(0) // LLM never called while the breaker is open
    expect(stats).toMatchObject({ breakerOpen: true, llmUsed: false, fallbackCount: 1 })
    expect(out[0].explanation.length).toBeGreaterThan(0) // deterministic fallback still served
  })

  it('records LLM failures into the breaker, opening it after the threshold', async () => {
    const breaker = new CircuitBreaker({ name: 'claude-test', failureThreshold: 2, cooldownMs: 60_000, now: () => 0, store: new InMemoryStore() })
    const failing: ExplanationClient = { generate: vi.fn().mockRejectedValue(new Error('haiku down')) }
    const results = [makeResult({ content: { id: 'a' } })]

    await generateExplanations({ results, queryText: 'q' }, { client: failing, breaker }) // failure 1
    expect((await breaker.snapshot()).state).toBe('closed')
    await generateExplanations({ results, queryText: 'q' }, { client: failing, breaker }) // failure 2 → open
    expect((await breaker.snapshot()).state).toBe('open')

    const callsBefore = (failing.generate as ReturnType<typeof vi.fn>).mock.calls.length
    const { stats } = await generateExplanations({ results, queryText: 'q' }, { client: failing, breaker })
    expect((failing.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore) // not called again
    expect(stats.breakerOpen).toBe(true)
  })

  it('serves repeat requests from cache without re-calling the client', async () => {
    const cache = createInMemoryExplanationCache()
    const client = fakeClient((items) => new Map(items.map((i) => [i.contentId, `LLM: ${i.contentId}`])))
    const input = { results: [makeResult({ content: { id: 'a' } })], queryText: 'same query' }

    const first = await generateExplanations(input, { client, cache })
    const second = await generateExplanations(input, { client, cache })

    expect(client.calls).toBe(1) // second call fully served from cache
    expect(second.results[0].explanation).toBe(first.results[0].explanation)
    expect(first.stats).toMatchObject({ cacheHits: 0, cacheMisses: 1 })
    expect(second.stats).toMatchObject({ cacheHits: 1, cacheMisses: 0 })
  })

  it('keys the cache by query, so a different query regenerates', async () => {
    const cache = createInMemoryExplanationCache()
    const client = fakeClient((items) => new Map(items.map((i) => [i.contentId, `LLM: ${i.contentId}`])))
    const results = [makeResult({ content: { id: 'a' } })]

    await generateExplanations({ results, queryText: 'query one' }, { client, cache })
    await generateExplanations({ results, queryText: 'query two' }, { client, cache })

    expect(client.calls).toBe(2)
  })

  it('never caches fallback explanations (C2 — no cache poisoning on outage)', async () => {
    const cache = createInMemoryExplanationCache()
    // No client → every result resolves via deterministic fallback.
    await generateExplanations({ results: [makeResult({ content: { id: 'a' } })], queryText: 'q' }, { cache })
    expect(await cache.get(explanationCacheKey('a', hashQuery('q')))).toBeUndefined()
  })

  it('does not cache fallbacks for items the client omitted, but does cache the ones it returned', async () => {
    const cache = createInMemoryExplanationCache()
    const client = fakeClient(() => new Map([['a', 'LLM: a']])) // 'b' omitted → fallback
    await generateExplanations(
      { results: [makeResult({ content: { id: 'a' } }), makeResult({ content: { id: 'b' } })], queryText: 'q' },
      { client, cache }
    )
    expect(await cache.get(explanationCacheKey('a', hashQuery('q')))).toBe('LLM: a')
    expect(await cache.get(explanationCacheKey('b', hashQuery('q')))).toBeUndefined()
  })

  it('isolates cached explanations per taste context (C1 — no cross-user bleed)', async () => {
    const cache = createInMemoryExplanationCache()
    const client = fakeClient((items) => new Map(items.map((i) => [i.contentId, `LLM: ${i.contentId}`])))
    const results = [makeResult({ content: { id: 'a' } })]

    // Same query, two different users (different taste seeds) must NOT share a cache entry.
    await generateExplanations({ results, queryText: 'q', tasteSeeds: [seed('loved', { id: 'u1' })] }, { client, cache })
    await generateExplanations({ results, queryText: 'q', tasteSeeds: [seed('loved', { id: 'u2' })] }, { client, cache })
    expect(client.calls).toBe(2)

    // The same user (same seeds) on the same query IS served from cache.
    await generateExplanations({ results, queryText: 'q', tasteSeeds: [seed('loved', { id: 'u1' })] }, { client, cache })
    expect(client.calls).toBe(2)
  })
})
