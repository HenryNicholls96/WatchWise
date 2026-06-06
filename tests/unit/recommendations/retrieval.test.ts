import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUERY_EMBED_DIMENSIONS, RetrievalError, createVoyageEmbeddingClient } from '@/lib/recommendations/retrieval'
import { CircuitBreaker } from '@/lib/utils/circuit-breaker'
import { InMemoryStore } from '@/lib/utils/distributed-store'

function okVoyage() {
  return { embed: vi.fn(async () => ({ data: [{ embedding: new Array(QUERY_EMBED_DIMENSIONS).fill(0.1) }] })) }
}
function failVoyage() {
  return { embed: vi.fn(async () => { throw new Error('voyage down') }) }
}

// Each breaker gets its own in-memory store so the singleton's state can't leak between cases.
function makeBreaker(name = 'voyage-test') {
  return new CircuitBreaker({ name, failureThreshold: 1, cooldownMs: 60_000, now: () => 0, store: new InMemoryStore() })
}

afterEach(() => vi.useRealTimers())

describe('createVoyageEmbeddingClient — circuit breaker', () => {
  it('fails fast WITHOUT calling Voyage when the breaker is open', async () => {
    const breaker = makeBreaker()
    await breaker.recordFailure() // → open
    const voyage = okVoyage()
    const client = createVoyageEmbeddingClient(voyage, undefined, breaker)

    await expect(client.embedQuery('hi')).rejects.toBeInstanceOf(RetrievalError)
    expect(voyage.embed).not.toHaveBeenCalled() // rejected before any upstream call
  })

  it('records a failure (and opens) after embed retries are exhausted', async () => {
    vi.useFakeTimers()
    const breaker = makeBreaker()
    const voyage = failVoyage()
    const client = createVoyageEmbeddingClient(voyage, undefined, breaker)

    const p = client.embedQuery('a')
    p.catch(() => {}) // avoid unhandled rejection while we advance timers
    await vi.advanceTimersByTimeAsync(7_000) // run through the 1s/2s/4s backoff sleeps
    await expect(p).rejects.toBeInstanceOf(RetrievalError)

    expect(voyage.embed).toHaveBeenCalled()
    expect((await breaker.snapshot()).state).toBe('open') // failure recorded → opened (threshold 1)
  })

  it('records success and keeps the breaker closed on a healthy embed', async () => {
    const breaker = makeBreaker()
    const client = createVoyageEmbeddingClient(okVoyage(), undefined, breaker)

    const embedding = await client.embedQuery('hi')
    expect(embedding).toHaveLength(QUERY_EMBED_DIMENSIONS)
    expect((await breaker.snapshot()).state).toBe('closed')
  })
})
