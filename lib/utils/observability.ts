// Observability for the recommendation hot path — one structured event per request.
//
// Deliberately tiny and dependency-free: a monotonic timer, the canonical event shape, and a
// fail-open emit. Centralizing the event shape here means the sink (console today; a log drain,
// PostHog, or OTel later) can change without touching call sites.

import { createHash } from 'node:crypto'
import type { Logger } from '@/lib/types/logger'

/** Starts a timer; the returned function reports elapsed whole milliseconds since start. */
export function startTimer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

/**
 * Stable correlation id tying one user journey together — the initial recommendation_request and its
 * deferred explanation_request. Both endpoints derive it identically from the caller (userId, else IP)
 * and the query hash, so they share a journeyId WITHOUT the frontend threading anything. Truncated SHA-256;
 * not security-sensitive. Empty string is used for pre-pipeline rejections (no query yet).
 */
export function makeJourneyId(caller: string, queryHash: string): string {
  return createHash('sha256').update(`${caller}:${queryHash}`).digest('hex').slice(0, 16)
}

// ─── Release / deploy identity ──────────────────────────────────────────────────

let cachedRelease: string | undefined

/**
 * Resolves the running release identifier from the environment. Pure (env injected) so precedence is
 * unit-testable. Order: VERCEL_GIT_COMMIT_SHA (set by Vercel at build) → generic RELEASE → GIT_COMMIT_SHA →
 * 'unknown'. A full 40-char hex SHA is shortened to 7 chars for readable logs; other values pass through.
 */
export function resolveRelease(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.VERCEL_GIT_COMMIT_SHA ?? env.RELEASE ?? env.GIT_COMMIT_SHA ?? '').trim()
  if (!raw) return 'unknown'
  return /^[0-9a-f]{40}$/i.test(raw) ? raw.slice(0, 7) : raw
}

/**
 * Current release id, resolved ONCE and memoized — a deploy is immutable, so there's no need to re-read
 * env per request, and the call is essentially free on the hot path. Fail-safe: any error → 'unknown'.
 * Stamped on every observability event so metrics can be sliced by deploy (and paired with `flags` to spot
 * deploy×flag regressions).
 */
export function getCurrentRelease(): string {
  if (cachedRelease === undefined) {
    try {
      cachedRelease = resolveRelease()
    } catch {
      cachedRelease = 'unknown'
    }
  }
  return cachedRelease
}

/** Test helper — clears the memoized release so a test's stubbed env is re-read. */
export function __resetReleaseCacheForTests(): void {
  cachedRelease = undefined
}

/** Per-stage latencies of one pipeline run (ms). */
export type StageTimings = {
  retrieveMs: number
  filterMs: number
  scoreMs: number
  explainMs: number
  offersMs: number
}

/** Explanation cache + LLM-resilience signals rolled up for one request. */
export type ExplanationMetrics = {
  cacheHits: number
  cacheMisses: number
  llmUsed: boolean
  fallbackCount: number
  /** True when the LLM batch tripped the wall-clock deadline (the dominant fallback cause at launch). */
  deadlineHit: boolean
  /** True when the LLM call errored outright (vs. timed out). */
  llmError: boolean
  /** Transient LLM retries before the call resolved or gave up — a Claude flakiness signal. */
  llmRetries: number
  /** True when the Claude circuit breaker was open, so the LLM was skipped and we went straight to
   *  deterministic fallbacks (protecting latency on a struggling upstream). */
  breakerOpen: boolean
}

/** Retrieval → return funnel for one request. */
export type FunnelMetrics = {
  retrieved: number
  filtered: number
  returned: number
  zeroResult: boolean
  genreExclusionsRelaxed: boolean
}

/**
 * Everything the engine measures for one pipeline run. Assembled from values the engine has already
 * computed (lengths, timings, flags), so building it cannot throw.
 */
export type RecommendationPipelineMetrics = {
  stages: StageTimings
  explanation: ExplanationMetrics
  funnel: FunnelMetrics
  /** Fraction (0–1) of returned results carrying a blended_rating. */
  blendedCoverage: number
}

/** The one structured event emitted per recommendation request. */
export type RecommendationMetrics = {
  event: 'recommendation_request'
  requestId: string
  /** Correlation id shared with the deferred explanation_request for the same search ('' pre-pipeline). */
  journeyId: string
  /** 'ok' on success; 'error' covers pipeline failures, rate limits ('RATE_LIMITED'), and bad input
   *  ('BAD_REQUEST') — see errorCode. */
  outcome: 'ok' | 'error'
  errorCode?: string
  totalMs: number
  /** Present on success; omitted when the request failed before producing results. */
  pipeline?: RecommendationPipelineMetrics
  /** Feature flags resolved for this request's caller (`{ [name]: enabled }`). Lets us slice metrics by
   *  variant and confirm which flags/kill-switches were active. Omitted on pre-pipeline rejections. */
  flags?: Record<string, boolean>
  /** Release identifier (short commit SHA / RELEASE env, else 'unknown') of the deploy that served this
   *  request — so a regression can be tied to a specific deploy. Stamped on every terminal path. */
  release?: string
}

/**
 * Emits the single structured request event. FAIL-OPEN: never throws — observability must not affect
 * the response. Error and zero-result outcomes are raised to warn so they surface above info noise.
 */
export function emitRecommendationMetrics(logger: Logger, metrics: RecommendationMetrics): void {
  try {
    const elevated = metrics.outcome === 'error' || metrics.pipeline?.funnel.zeroResult === true
    logger[elevated ? 'warn' : 'info'](metrics.event, metrics as unknown as Record<string, unknown>)
  } catch {
    // Swallow — a logging failure must never break a recommendation response.
  }
}

/** The structured event emitted per deferred-explanation request (POST /api/recommendations/explanations). */
export type ExplanationRequestMetrics = {
  event: 'explanation_request'
  requestId: string
  /** Correlation id shared with the originating recommendation_request ('' pre-pipeline). */
  journeyId: string
  outcome: 'ok' | 'error'
  errorCode?: string
  totalMs: number
  /** How many results the re-run set out to explain. */
  requested: number
  /** How many we returned an explanation for; `explained < requested` signals partial output. */
  explained: number
  /** Cache/LLM stats for this batch — the signal that moved here from the main request when explanations
   *  were decoupled. Omitted on the error path. */
  explanation?: ExplanationMetrics
  /** Feature flags resolved for this request's caller (`{ [name]: enabled }`) — e.g. explanations_llm, which
   *  gates the LLM call here. Omitted on pre-pipeline rejections. */
  flags?: Record<string, boolean>
  /** Release identifier of the deploy that served this request (short commit SHA / RELEASE env, else
   *  'unknown'). Stamped on every terminal path. */
  release?: string
}

/** Emits the explanation-request event. FAIL-OPEN (same contract as emitRecommendationMetrics). */
export function emitExplanationMetrics(logger: Logger, metrics: ExplanationRequestMetrics): void {
  try {
    logger[metrics.outcome === 'error' ? 'warn' : 'info'](metrics.event, metrics as unknown as Record<string, unknown>)
  } catch {
    // Swallow — observability must never break the response.
  }
}

/** Emitted on a circuit-breaker state transition (Claude / Voyage), so opens/recoveries are visible. */
export type CircuitBreakerEvent = {
  event: 'circuit_breaker'
  breaker: string
  state: 'closed' | 'open' | 'half-open'
  consecutiveFailures: number
  /** Present when opening — how long the breaker will reject/skip calls before a half-open trial. */
  cooldownMs?: number
}

/** Emits a circuit-breaker transition. Opens raise to warn; recoveries/trials are info. FAIL-OPEN. */
export function emitCircuitBreakerEvent(logger: Logger, e: CircuitBreakerEvent): void {
  try {
    logger[e.state === 'open' ? 'warn' : 'info'](e.event, e as unknown as Record<string, unknown>)
  } catch {
    // Swallow — observability must never break the breaker.
  }
}
