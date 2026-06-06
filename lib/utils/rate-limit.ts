// Fixed-window rate limiter.
//
// Blunts cost-amplification abuse of the recommendation endpoints (each request fans out to paid Voyage
// + Claude calls). State lives in the configured DistributedStore (see distributed-store.ts): in-memory
// per-process by default, or Upstash Redis when configured — then the window counter is GLOBAL across
// all serverless instances, closing the "effective limit × instance count" gap.
//
// FAIL-OPEN: if the store errors (e.g. Redis unreachable), the request is ALLOWED. A limiter outage must
// never block users; the cost is that abuse protection lapses for the duration of the outage. This is
// logged so it's visible.

import { type Logger, consoleLogger } from '@/lib/types/logger'
import {
  type DistributedStore,
  __resetDistributedStoreForTests,
  getDistributedStore,
} from '@/lib/utils/distributed-store'

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  /** Epoch ms when the current window resets. */
  resetAt: number
  /** Seconds until reset — suitable for a Retry-After header. */
  retryAfterSeconds: number
}

export type RateLimitDeps = {
  /** Defaults to the process-wide store singleton; inject a fresh store in tests. */
  store?: DistributedStore
  logger?: Logger
}

/**
 * Records one hit against `key` and reports whether it is within `limit` per `windowMs`.
 * `now` is injectable for deterministic tests. Fail-open: any store error resolves to `allowed: true`.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
  deps: RateLimitDeps = {}
): Promise<RateLimitResult> {
  const store = deps.store ?? getDistributedStore()
  try {
    const { count, resetAt } = await store.incrementWindow(key, windowMs, now)
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    }
  } catch (err) {
    ;(deps.logger ?? consoleLogger).warn('rate limiter store error — allowing (fail-open)', {
      message: err instanceof Error ? err.message : String(err),
    })
    return { allowed: true, limit, remaining: limit, resetAt: now + windowMs, retryAfterSeconds: 1 }
  }
}

/** Test helper — clears all in-memory counters (no-op under a Redis backend). */
export function __resetRateLimitStore(): void {
  __resetDistributedStoreForTests()
}
