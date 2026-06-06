// Circuit breaker for protecting flaky upstreams (Claude, Voyage).
//
// States: CLOSED (calls flow) → after `failureThreshold` consecutive failures → OPEN (calls rejected/
// skipped fast for `cooldownMs`) → HALF-OPEN (the next call is a trial; success closes, failure re-opens).
//
// State is held in the configured DistributedStore (see distributed-store.ts): process-local by default,
// or shared across all serverless instances when Upstash is configured — so one instance learning an
// upstream is down protects the others. The state machine itself is a PURE reducer (reduceBreaker) shared
// by both backends; the breaker just reads the current state, reduces, and writes back.
//
// CONCURRENCY: the Redis path is read-modify-write (last-writer-wins), not a distributed lock. Two
// instances failing simultaneously can lose an increment, so the breaker may take a few extra failures to
// open under high concurrency — acceptable for a best-effort, fail-open protective mechanism (it still
// opens, just slightly later). The high-value exactness guarantee (the global rate limit) uses an atomic
// server-side increment instead; see distributed-store.ts.
//
// FAIL-OPEN by construction: every public method swallows errors and resolves to "allow"/no-op, so a
// store outage or breaker bug can never block traffic. State transitions emit a circuit_breaker event.

import { type Logger, consoleLogger, noopLogger } from '@/lib/types/logger'
import { type DistributedStore, getDistributedStore } from '@/lib/utils/distributed-store'
import { emitCircuitBreakerEvent } from '@/lib/utils/observability'

export type CircuitState = 'closed' | 'open' | 'half-open'

export type CircuitBreakerOptions = {
  name: string
  /** Consecutive failures (while closed) that trip the breaker open. */
  failureThreshold: number
  /** How long to stay open before allowing a single half-open trial. */
  cooldownMs: number
  logger?: Logger
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Backing store. Defaults to the process-wide singleton; inject a fresh store in tests for isolation. */
  store?: DistributedStore
}

/** The breaker's persisted state — the full machine, so any instance can resume it. */
type BreakerState = { state: CircuitState; consecutiveFailures: number; openUntil: number }
const INITIAL: BreakerState = { state: 'closed', consecutiveFailures: 0, openUntil: 0 }

type BreakerAction = 'allow' | 'success' | 'failure'
type ReduceResult = {
  next: BreakerState
  /** The state to emit, set only when this action caused a transition. */
  transitionTo?: CircuitState
  /** For 'allow': whether the call should proceed. */
  allowed: boolean
}

/**
 * Pure state-machine step. Used by every backend so the open/half-open/close logic lives in exactly one
 * place. Mirrors the original in-process semantics: a half-open failure re-opens immediately; openUntil
 * refreshes on each failure while open.
 */
export function reduceBreaker(
  cur: BreakerState,
  action: BreakerAction,
  opts: { failureThreshold: number; cooldownMs: number },
  now: number
): ReduceResult {
  let { state, consecutiveFailures, openUntil } = cur
  let transitionTo: CircuitState | undefined

  if (action === 'allow') {
    if (state === 'open' && now >= openUntil) {
      state = 'half-open'
      transitionTo = 'half-open'
    }
    return { next: { state, consecutiveFailures, openUntil }, transitionTo, allowed: state !== 'open' }
  }

  if (action === 'success') {
    consecutiveFailures = 0
    if (state !== 'closed') {
      state = 'closed'
      transitionTo = 'closed'
    }
    return { next: { state, consecutiveFailures, openUntil }, transitionTo, allowed: true }
  }

  // failure
  consecutiveFailures += 1
  if (state === 'half-open' || consecutiveFailures >= opts.failureThreshold) {
    openUntil = now + opts.cooldownMs
    if (state !== 'open') transitionTo = 'open'
    state = 'open'
  }
  return { next: { state, consecutiveFailures, openUntil }, transitionTo, allowed: false }
}

export class CircuitBreaker {
  readonly name: string
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly logger: Logger
  private readonly now: () => number
  private readonly store: DistributedStore
  private readonly key: string

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name
    this.failureThreshold = Math.max(1, Math.floor(opts.failureThreshold))
    this.cooldownMs = Math.max(0, opts.cooldownMs)
    this.logger = opts.logger ?? noopLogger
    this.now = opts.now ?? (() => Date.now())
    this.store = opts.store ?? getDistributedStore()
    this.key = `cb:${this.name}`
  }

  /** Whether a call should be attempted. Open → false until the cooldown elapses, then a half-open trial. */
  async allow(): Promise<boolean> {
    try {
      return (await this.mutate('allow')).allowed
    } catch {
      return true // fail-open: never block traffic because of a breaker/store error
    }
  }

  async recordSuccess(): Promise<void> {
    try {
      await this.mutate('success')
    } catch {
      // ignore — recording must never throw
    }
  }

  async recordFailure(): Promise<void> {
    try {
      await this.mutate('failure')
    } catch {
      // ignore — recording must never throw
    }
  }

  /** Current state — for per-request observability flags and tests. Fail-open to a closed reading. */
  async snapshot(): Promise<{ state: CircuitState; consecutiveFailures: number }> {
    try {
      const cur = (await this.store.getJson<BreakerState>(this.key)) ?? INITIAL
      return { state: cur.state, consecutiveFailures: cur.consecutiveFailures }
    } catch {
      return { state: 'closed', consecutiveFailures: 0 }
    }
  }

  /** Test helper — clear this breaker's state. Fire-and-forget (in-memory del is synchronous-effective). */
  reset(): void {
    void this.store.del(this.key)
  }

  /** TTL on persisted state so an abandoned (e.g. cold-instance) breaker self-clears back to closed. */
  private stateTtlMs(): number {
    return Math.max(this.cooldownMs * 5, 60_000)
  }

  private async mutate(action: BreakerAction): Promise<ReduceResult> {
    const cur = (await this.store.getJson<BreakerState>(this.key)) ?? INITIAL
    const result = reduceBreaker(cur, action, { failureThreshold: this.failureThreshold, cooldownMs: this.cooldownMs }, this.now())
    if (changed(cur, result.next)) await this.store.setJson(this.key, result.next, this.stateTtlMs())
    if (result.transitionTo) {
      emitCircuitBreakerEvent(this.logger, {
        event: 'circuit_breaker',
        breaker: this.name,
        state: result.transitionTo,
        consecutiveFailures: result.next.consecutiveFailures,
        cooldownMs: result.transitionTo === 'open' ? this.cooldownMs : undefined,
      })
    }
    return result
  }
}

function changed(a: BreakerState, b: BreakerState): boolean {
  return a.state !== b.state || a.consecutiveFailures !== b.consecutiveFailures || a.openUntil !== b.openUntil
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// ─── Shared breakers (tunable via env) ──────────────────────────────────────────
// State lives in the distributed store, keyed by name — so all instances share one breaker per upstream.

/** Trips after a few requests where Claude timed out or errored → skip the LLM, serve fallbacks. */
export const claudeBreaker = new CircuitBreaker({
  name: 'claude',
  failureThreshold: envInt('CLAUDE_BREAKER_FAILURE_THRESHOLD', 3),
  cooldownMs: envInt('CLAUDE_BREAKER_COOLDOWN_MS', 30_000),
  logger: consoleLogger,
})

/** Trips after sustained embed failures (each already retried) → fail fast instead of hanging. */
export const voyageBreaker = new CircuitBreaker({
  name: 'voyage',
  failureThreshold: envInt('VOYAGE_BREAKER_FAILURE_THRESHOLD', 4),
  cooldownMs: envInt('VOYAGE_BREAKER_COOLDOWN_MS', 15_000),
  logger: consoleLogger,
})
