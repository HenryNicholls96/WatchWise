// Proves the distributed-state goal: when multiple "instances" share one store, rate-limit counters and
// circuit-breaker state are GLOBAL (not per-process). Also covers the Upstash REST backend's wire format
// and the env-driven backend selection.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { noopLogger } from '@/lib/types/logger'
import {
  InMemoryStore,
  UpstashStore,
  createStoreFromEnv,
} from '@/lib/utils/distributed-store'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { CircuitBreaker } from '@/lib/utils/circuit-breaker'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('shared state across simulated instances', () => {
  it('rate limit: one shared store enforces a single GLOBAL limit across instances', async () => {
    // Two "serverless instances" pointed at the same backend.
    const store = new InMemoryStore()
    const instanceA = { store }
    const instanceB = { store }
    const key = 'user:x'

    // limit 3 — split across the two instances, the 4th request overall is blocked.
    expect((await checkRateLimit(key, 3, 60_000, 0, instanceA)).allowed).toBe(true) // 1
    expect((await checkRateLimit(key, 3, 60_000, 0, instanceB)).allowed).toBe(true) // 2
    expect((await checkRateLimit(key, 3, 60_000, 0, instanceA)).allowed).toBe(true) // 3
    expect((await checkRateLimit(key, 3, 60_000, 0, instanceB)).allowed).toBe(false) // 4 → over the global cap
  })

  it('rate limit: WITHOUT a shared store the effective limit multiplies per instance (the bug we fixed)', async () => {
    const instanceA = { store: new InMemoryStore() }
    const instanceB = { store: new InMemoryStore() }
    const key = 'user:x'

    // Each per-process store allows the full limit independently → effective global limit is 2× here.
    expect((await checkRateLimit(key, 1, 60_000, 0, instanceA)).allowed).toBe(true)
    expect((await checkRateLimit(key, 1, 60_000, 0, instanceB)).allowed).toBe(true) // both allow their own #1
  })

  it('circuit breaker: opening on one instance is seen by another sharing the store', async () => {
    const store = new InMemoryStore()
    let clock = 0
    const opts = { name: 'voyage', failureThreshold: 2, cooldownMs: 1_000, now: () => clock, store }
    const instanceA = new CircuitBreaker(opts)
    const instanceB = new CircuitBreaker(opts)

    // A drives the breaker open; B never recorded a failure itself.
    await instanceA.recordFailure()
    await instanceA.recordFailure() // threshold 2 → open
    expect((await instanceA.snapshot()).state).toBe('open')

    // B observes the shared OPEN state and fails fast.
    expect(await instanceB.allow()).toBe(false)
    expect((await instanceB.snapshot()).state).toBe('open')

    // After the cooldown, B's allow() drives the half-open trial; A then sees the transition.
    clock += 1_000
    expect(await instanceB.allow()).toBe(true) // half-open trial on B
    expect((await instanceA.snapshot()).state).toBe('half-open')
    await instanceA.recordSuccess() // A closes it
    expect((await instanceB.snapshot()).state).toBe('closed')
  })
})

describe('UpstashStore (REST wire format)', () => {
  function mockFetch(resultFor: (cmd: string[]) => unknown) {
    const calls: string[][] = []
    const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const cmd = JSON.parse(init.body) as string[]
      calls.push(cmd)
      return new Response(JSON.stringify({ result: resultFor(cmd) }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls, fetchMock }
  }

  it('incrementWindow issues an atomic EVAL and parses [count, ttl]', async () => {
    const { calls } = mockFetch(() => [2, 45_000])
    const store = new UpstashStore('https://redis.example', 'tok', 1_000, noopLogger)

    const hit = await store.incrementWindow('rl:user:x', 60_000)
    expect(hit.count).toBe(2)
    expect(hit.resetAt).toBeGreaterThan(Date.now() - 1) // now + ttl

    const cmd = calls[0]
    expect(cmd[0]).toBe('EVAL')
    expect(cmd).toContain('rl:user:x') // KEYS[1]
    expect(cmd).toContain('60000') // ARGV[1] = windowMs
  })

  it('getJson / setJson / del issue GET / SET..PX / DEL with the right args, and a bearer token', async () => {
    const { calls, fetchMock } = mockFetch((cmd) => (cmd[0] === 'GET' ? JSON.stringify({ state: 'open' }) : 'OK'))
    const store = new UpstashStore('https://redis.example', 'tok', 1_000, noopLogger)

    expect(await store.getJson('cb:claude')).toEqual({ state: 'open' })
    await store.setJson('cb:claude', { state: 'closed' }, 5_000)
    await store.del('cb:claude')

    expect(calls[0]).toEqual(['GET', 'cb:claude'])
    expect(calls[1].slice(0, 2)).toEqual(['SET', 'cb:claude'])
    expect(calls[1]).toContain('PX')
    expect(calls[1]).toContain('5000')
    expect(calls[2]).toEqual(['DEL', 'cb:claude'])

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('throws on a non-OK response so callers can fail open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const store = new UpstashStore('https://redis.example', 'tok', 1_000, noopLogger)
    await expect(store.getJson('k')).rejects.toThrow()
  })
})

describe('createStoreFromEnv', () => {
  it('uses in-memory when backend=memory even if creds exist', () => {
    vi.stubEnv('DISTRIBUTED_STATE_BACKEND', 'memory')
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://r')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't')
    expect(createStoreFromEnv(noopLogger)).toBeInstanceOf(InMemoryStore)
  })

  it('uses Upstash on auto when both creds are present', () => {
    vi.stubEnv('DISTRIBUTED_STATE_BACKEND', 'auto')
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://r')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't')
    expect(createStoreFromEnv(noopLogger)).toBeInstanceOf(UpstashStore)
  })

  it('falls back to in-memory on auto when creds are missing', () => {
    vi.stubEnv('DISTRIBUTED_STATE_BACKEND', 'auto')
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    expect(createStoreFromEnv(noopLogger)).toBeInstanceOf(InMemoryStore)
  })

  it('fails open to in-memory when backend=redis but creds are missing (no crash)', () => {
    vi.stubEnv('DISTRIBUTED_STATE_BACKEND', 'redis')
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    expect(createStoreFromEnv(noopLogger)).toBeInstanceOf(InMemoryStore)
  })
})
