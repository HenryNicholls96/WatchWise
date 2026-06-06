import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/types/logger'
import { CircuitBreaker } from '@/lib/utils/circuit-breaker'
import { InMemoryStore } from '@/lib/utils/distributed-store'

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Breaker with an injectable clock + an isolated in-memory store (advance ms via the returned helper). */
function makeBreaker(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let clock = 0
  const logger = spyLogger()
  const breaker = new CircuitBreaker({
    name: 'test',
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 1_000,
    logger,
    now: () => clock,
    store: new InMemoryStore(),
  })
  return { breaker, logger, advance: (d: number) => (clock += d) }
}

describe('CircuitBreaker', () => {
  it('allows calls while closed', async () => {
    const { breaker } = makeBreaker()
    expect(await breaker.allow()).toBe(true)
    expect((await breaker.snapshot()).state).toBe('closed')
  })

  it('opens after the failure threshold and then rejects calls, emitting a warn event', async () => {
    const { breaker, logger } = makeBreaker({ failureThreshold: 3 })
    await breaker.recordFailure()
    await breaker.recordFailure()
    expect(await breaker.allow()).toBe(true) // 2 < 3, still closed
    await breaker.recordFailure() // 3rd → open
    expect(await breaker.allow()).toBe(false)
    expect((await breaker.snapshot()).state).toBe('open')

    const opened = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'circuit_breaker')
    expect(opened?.[1]).toMatchObject({ breaker: 'test', state: 'open', consecutiveFailures: 3, cooldownMs: 1_000 })
  })

  it('resets the failure count on success (stays closed below threshold)', async () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 })
    await breaker.recordFailure()
    await breaker.recordFailure()
    await breaker.recordSuccess() // reset
    await breaker.recordFailure()
    await breaker.recordFailure() // only 2 since reset → still closed
    expect(await breaker.allow()).toBe(true)
    expect((await breaker.snapshot()).state).toBe('closed')
  })

  it('moves to half-open after the cooldown and closes on a successful trial', async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
    await breaker.recordFailure() // open
    expect(await breaker.allow()).toBe(false)
    advance(1_000)
    expect(await breaker.allow()).toBe(true) // half-open trial
    expect((await breaker.snapshot()).state).toBe('half-open')
    await breaker.recordSuccess()
    expect((await breaker.snapshot()).state).toBe('closed')
  })

  it('re-opens immediately if the half-open trial fails', async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
    await breaker.recordFailure() // open
    advance(1_000)
    expect(await breaker.allow()).toBe(true) // half-open
    await breaker.recordFailure() // trial failed → re-open
    expect((await breaker.snapshot()).state).toBe('open')
    expect(await breaker.allow()).toBe(false)
  })

  it('is fail-open: never throws even if the logger throws on transition', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(() => { throw new Error('sink down') }),
      warn: vi.fn(() => { throw new Error('sink down') }),
      error: vi.fn(),
    }
    const breaker = new CircuitBreaker({ name: 't', failureThreshold: 1, cooldownMs: 100, logger, now: () => 0, store: new InMemoryStore() })
    await expect(breaker.recordFailure()).resolves.not.toThrow() // opening transition emits — logger throws, swallowed
    await expect(breaker.allow()).resolves.not.toThrow()
  })

  it('is fail-open: allows when the backing store errors', async () => {
    const store = {
      incrementWindow: async () => ({ count: 0, resetAt: 0 }),
      getJson: async () => {
        throw new Error('redis down')
      },
      setJson: async () => {},
      del: async () => {},
    }
    const breaker = new CircuitBreaker({ name: 'x', failureThreshold: 1, cooldownMs: 100, now: () => 0, store })
    expect(await breaker.allow()).toBe(true) // store read failed → fail open
    await expect(breaker.recordFailure()).resolves.not.toThrow()
  })
})
