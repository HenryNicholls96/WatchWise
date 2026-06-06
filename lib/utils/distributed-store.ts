// Distributed state backend for the rate limiter and circuit breakers.
//
// WHY: the rate limiter and both circuit breakers hold state that must be shared across every serverless
// instance to be correct. In-memory, per-process state means the effective rate limit is multiplied by
// the instance count (a real cost-protection gap on Vercel), and each instance learns an upstream is down
// independently. This module abstracts that state behind a small interface with two interchangeable
// backends, selected by env:
//   • InMemoryStore — process-local Maps; the default. Identical behavior to the old per-process code,
//     so local dev and tests need no external service.
//   • UpstashStore  — Upstash Redis over its REST API (plain fetch, no SDK dependency). Shared across all
//     instances, so limits and breaker state are global.
//
// FAIL-OPEN: every backend call can fail (network, outage). Callers (rate-limit.ts, circuit-breaker.ts)
// treat any store error as "allow" — a Redis outage must never block a user request. This trades abuse
// protection for availability during an outage, consistent with the project's fail-open philosophy.

import { type Logger, consoleLogger } from '@/lib/types/logger'

/** One fixed-window counter read: the current count and when the window resets (epoch ms). */
export type WindowHit = { count: number; resetAt: number }

/**
 * The narrow state operations the rate limiter and circuit breakers need. Kept generic (not limiter- or
 * breaker-specific) so any KV/Redis-like store can implement it; Upstash is one implementation.
 */
export interface DistributedStore {
  /**
   * Atomically increments a fixed-window counter and returns the new count + window reset time. The first
   * hit in a window sets the expiry to windowMs. `now` is injectable for deterministic in-memory tests
   * (the Redis backend uses server-side time and ignores it for the count, deriving resetAt from the TTL).
   */
  incrementWindow(key: string, windowMs: number, now: number): Promise<WindowHit>
  /** Reads a JSON value, or null if absent/expired. Throws on a backend error (callers fail open). */
  getJson<T>(key: string): Promise<T | null>
  /** Writes a JSON value with an optional TTL (ms). */
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>
  /** Deletes a key. */
  del(key: string): Promise<void>
}

// ─── In-memory backend (default) ────────────────────────────────────────────────

type Bucket = { count: number; resetAt: number }
type Entry = { value: string; expiresAt: number | null }

/** Cap the maps so a flood of distinct keys (e.g. spoofed IPs) can't grow memory unbounded. */
const MAX_KEYS = 50_000

/**
 * Process-local backend. Mutations take effect synchronously (the returned promise is already resolved),
 * which is why the sync test helpers below can clear state without awaiting.
 */
export class InMemoryStore implements DistributedStore {
  private readonly windows = new Map<string, Bucket>()
  private readonly kv = new Map<string, Entry>()

  async incrementWindow(key: string, windowMs: number, now: number): Promise<WindowHit> {
    let bucket = this.windows.get(key)
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, bucket)
    }
    bucket.count += 1
    if (this.windows.size > MAX_KEYS) this.pruneWindows(now)
    return { count: bucket.count, resetAt: bucket.resetAt }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.kv.get(key)
    if (!entry) return null
    if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
      this.kv.delete(key)
      return null
    }
    return JSON.parse(entry.value) as T
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.kv.set(key, { value: JSON.stringify(value), expiresAt: ttlMs != null ? Date.now() + ttlMs : null })
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key)
  }

  /** Synchronous full clear — for the test reset helpers (in-memory only). */
  clearSync(): void {
    this.windows.clear()
    this.kv.clear()
  }

  private pruneWindows(now: number): void {
    for (const [key, bucket] of this.windows) {
      if (now >= bucket.resetAt) this.windows.delete(key)
    }
  }
}

// ─── Upstash Redis backend (REST over fetch) ────────────────────────────────────

// Atomic fixed-window increment. Returns {count, ttlMs}. The first request in a window (count === 1)
// sets the window's expiry; PTTL then reports the remaining window so we can compute resetAt. Running
// this server-side in one round-trip makes the global counter race-free across instances.
const INCR_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`.trim()

/** Upstash REST backend. Decoupled from the SDK — the REST contract is a JSON command array + bearer token. */
export class UpstashStore implements DistributedStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger = consoleLogger
  ) {}

  // `now` (3rd interface arg) is intentionally omitted: Redis uses server-side time, and resetAt is
  // derived from the TTL the script returns. A narrower implementation is still assignable to the interface.
  async incrementWindow(key: string, windowMs: number): Promise<WindowHit> {
    const res = await this.command<[number, number]>(['EVAL', INCR_WINDOW_LUA, '1', key, String(windowMs)])
    const count = Number(res?.[0] ?? 0)
    const ttl = Number(res?.[1] ?? windowMs)
    // PTTL is -1 (no expiry) / -2 (missing) only on a race; fall back to the full window for resetAt.
    return { count, resetAt: Date.now() + (ttl >= 0 ? ttl : windowMs) }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const res = await this.command<string | null>(['GET', key])
    return res == null ? null : (JSON.parse(res) as T)
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const cmd = ['SET', key, JSON.stringify(value)]
    if (ttlMs != null) cmd.push('PX', String(Math.max(1, Math.floor(ttlMs))))
    await this.command(cmd)
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', key])
  }

  private async command<T>(command: string[]): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!resp.ok) throw new Error(`upstash HTTP ${resp.status}`)
      const body = (await resp.json()) as { result?: T; error?: string }
      if (body.error) throw new Error(`upstash error: ${body.error}`)
      return body.result as T
    } finally {
      clearTimeout(timer)
    }
  }
}

// ─── Backend selection ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 1_000

/**
 * Builds the configured store. Selection:
 *   • DISTRIBUTED_STATE_BACKEND=memory          → always in-memory.
 *   • DISTRIBUTED_STATE_BACKEND=redis            → Upstash; if creds are missing, warn and use in-memory
 *                                                  (fail-open: a misconfiguration must not crash the app).
 *   • DISTRIBUTED_STATE_BACKEND=auto (default)   → Upstash when both creds are present, else in-memory.
 */
export function createStoreFromEnv(logger: Logger = consoleLogger): DistributedStore {
  const backend = (process.env.DISTRIBUTED_STATE_BACKEND ?? 'auto').toLowerCase()
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  const hasCreds = Boolean(url && token)

  if (backend === 'memory') return new InMemoryStore()

  if (backend === 'redis' && !hasCreds) {
    logger.warn('DISTRIBUTED_STATE_BACKEND=redis but UPSTASH_REDIS_REST_URL/TOKEN are unset — using in-memory')
    return new InMemoryStore()
  }

  if (hasCreds && backend !== 'memory') {
    const timeoutMs = Number(process.env.DISTRIBUTED_STATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    logger.info('distributed state backend: upstash-redis')
    return new UpstashStore(url!, token!, timeoutMs, logger)
  }

  return new InMemoryStore()
}

let activeStore: DistributedStore | undefined

/** The process-wide store singleton, lazily constructed from env on first use. */
export function getDistributedStore(): DistributedStore {
  if (!activeStore) activeStore = createStoreFromEnv()
  return activeStore
}

/** Which backend is active — 'redis' (shared/distributed) or 'memory' (per-process). Safe to surface
 *  (no URL/token); useful for a health/readiness probe to confirm distribution is actually on. */
export function getStoreBackend(): 'memory' | 'redis' {
  return getDistributedStore() instanceof UpstashStore ? 'redis' : 'memory'
}

/** Test helper — synchronously clears all in-memory state. No-op when a Redis backend is active. */
export function __resetDistributedStoreForTests(): void {
  if (activeStore instanceof InMemoryStore) activeStore.clearSync()
}

/** Test helper — forces a specific backend (or a fresh in-memory store) for the singleton. */
export function __setDistributedStoreForTests(store: DistributedStore | undefined): void {
  activeStore = store
}
