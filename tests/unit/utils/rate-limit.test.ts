import { afterEach, describe, expect, it } from 'vitest'
import { __resetRateLimitStore, checkRateLimit } from '@/lib/utils/rate-limit'
import { InMemoryStore } from '@/lib/utils/distributed-store'

afterEach(() => __resetRateLimitStore())

// A fresh store per test gives full isolation without touching the process singleton.
function freshDeps() {
  return { store: new InMemoryStore() }
}

describe('checkRateLimit', () => {
  it('allows up to the limit, then blocks within the window', async () => {
    const deps = freshDeps()
    const key = 'ip:1.2.3.4'
    for (let i = 1; i <= 3; i++) {
      expect((await checkRateLimit(key, 3, 60_000, 1_000, deps)).allowed).toBe(true)
    }
    const blocked = await checkRateLimit(key, 3, 60_000, 1_000, deps)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('resets after the window elapses', async () => {
    const deps = freshDeps()
    const key = 'ip:5.6.7.8'
    await checkRateLimit(key, 1, 60_000, 0, deps)
    expect((await checkRateLimit(key, 1, 60_000, 100, deps)).allowed).toBe(false) // still in window
    expect((await checkRateLimit(key, 1, 60_000, 60_001, deps)).allowed).toBe(true) // new window
  })

  it('keys are independent (per user / per IP isolation)', async () => {
    const deps = freshDeps()
    expect((await checkRateLimit('user:a', 1, 60_000, 0, deps)).allowed).toBe(true)
    expect((await checkRateLimit('user:a', 1, 60_000, 0, deps)).allowed).toBe(false)
    expect((await checkRateLimit('user:b', 1, 60_000, 0, deps)).allowed).toBe(true) // different key unaffected
  })

  it('reports decreasing remaining', async () => {
    const deps = freshDeps()
    expect((await checkRateLimit('k', 5, 60_000, 0, deps)).remaining).toBe(4)
    expect((await checkRateLimit('k', 5, 60_000, 0, deps)).remaining).toBe(3)
  })

  it('fails open (allows) when the backing store errors', async () => {
    const store = {
      incrementWindow: async () => {
        throw new Error('redis unreachable')
      },
      getJson: async () => null,
      setJson: async () => {},
      del: async () => {},
    }
    const res = await checkRateLimit('k', 1, 60_000, 0, { store })
    expect(res.allowed).toBe(true) // outage must never block users
  })
})
