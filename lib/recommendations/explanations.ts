// Explanations — step 5 of the recommendation pipeline.
//
// Attaches a 1-2 sentence "why this" explanation to each scored candidate, so no result is ever
// shown without a human-readable reason (a non-negotiable per CLAUDE.md). Explanations are grounded
// in the auditable scoreBreakdown from scoring.ts (semantic match, taste affinity, quality) plus the
// user's query and taste seeds — not generic filler.
//
// Caching: keyed by `${content_id}:${query_hash}:${taste_signature}` (see explanationCacheKey). The
// same title surfaced for the same query AND the same taste context reuses its explanation instead of
// re-hitting Claude Haiku. The cache is injected (ExplanationCache) so production can back it with the
// `recommendations` table (24h TTL) while tests and the thin vertical slice use the in-memory default.
// query_hash is a SHA-256 of the normalized query, derived here when the caller doesn't supply one.
//
// DEVIATION from CLAUDE.md: the doc specifies a `(content_id + query_hash)` key. That predates
// taste-aware explanations — our text now embeds taste references ("because you loved X"), so a
// query-only key would leak one user's personalized explanation to another user with the same query.
// We therefore append a taste_signature (hash of the user's sorted seed ids + sentiments). With no
// seeds the signature is empty and the key collapses to the original `content_id:query_hash`, which is
// safe to share because such explanations contain no per-user content.
//
// Resilience: explanation generation must never block recommendations. If the LLM client is absent or
// fails, every uncached result degrades to a deterministic fallback built from its own scoreBreakdown.
// The user always gets cards; the only thing lost is LLM phrasing. Fallbacks are NEVER written to the
// cache — a transient LLM outage must not poison the cache with degraded text for the whole TTL.
//
// Design notes vs recommendation-engine.md:
//   • The doc's ResultWithExplanation also carries `platformInfo: ContentPlatformRow`. We intentionally
//     omit it here — platform/deep-link attachment belongs to the engine.ts orchestrator (filters.ts
//     already owns availability). This module stays focused on text generation and is decoupled from
//     content_platforms. engine.ts joins platform data onto these results.
//   • The doc reads/writes the cache directly against Supabase inside this function. We invert that with
//     an injected ExplanationCache interface so the module is pure-ish and unit-testable without a DB;
//     a Supabase-backed adapter is a thin wrapper the engine provides.

import { z } from 'zod'
import { createHash } from 'node:crypto'
import { type ContentRow, type ContentType } from '@/lib/types/content'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { type TasteSeed } from '@/lib/types/taste'
import { type CircuitBreaker, claudeBreaker } from '@/lib/utils/circuit-breaker'
import {
  type Confidence,
  type ScoredCandidate,
  PERSONALIZATION_NEUTRAL,
  SIMILARITY_FLOOR,
  tagOverlap,
} from '@/lib/recommendations/scoring'

// ─── Tunables ─────────────────────────────────────────────────────────────────

const EXPLAIN_MODEL = 'claude-haiku-4-5'
const EXPLAIN_MAX_TOKENS = 1_024
const EXPLAIN_MAX_RETRIES = 2

/** Wall-clock budget for the batched Haiku call. Past this we abort it and use deterministic fallbacks,
 *  so a slow LLM can't stall a recommendation response (cold-cache p100 was ~7s, dominated by this call). */
const EXPLANATION_DEADLINE_MS = 3000

/** Personalization above this counts as "meaningfully influenced by your taste" for phrasing. */
const PERSONALIZATION_REFERENCE_THRESHOLD = PERSONALIZATION_NEUTRAL + 0.05
/** Below this affinity overlap we don't name a specific seed — too weak to claim "because you loved X". */
const AFFINITY_NAMING_THRESHOLD = 0.2

const DESCRIPTION_EXCERPT_CHARS = 240

// ─── Errors ───────────────────────────────────────────────────────────────────

export type ExplanationErrorCode = 'INVALID_INPUT' | 'GENERATION_FAILED'

export class ExplanationError extends Error {
  readonly code: ExplanationErrorCode
  override readonly cause?: unknown
  constructor(code: ExplanationErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'ExplanationError'
    this.code = code
    this.cause = cause
  }
}

// ─── Public contract ──────────────────────────────────────────────────────────

export type ExplanationInput = {
  /** Already-scored, already-ranked candidates (typically the top ~20 from scoreAndRank). */
  results: ScoredCandidate[]
  queryText: string
  /** SHA-256 of the normalized query. Derived from queryText when omitted. */
  queryHash?: string
  /** User's onboarding ratings — used to ground "because you loved X" references. */
  tasteSeeds?: TasteSeed[]
}

export type ResultWithExplanation = ScoredCandidate & {
  explanation: string
}

/** Rolled-up cache/LLM signals for one batch, surfaced to the engine for observability. */
export type ExplanationStats = {
  total: number
  cacheHits: number
  cacheMisses: number
  llmUsed: boolean
  fallbackCount: number
  /** The LLM batch tripped the wall-clock deadline (everything fell back). */
  deadlineHit: boolean
  /** The LLM call errored outright (vs. timed out). */
  llmError: boolean
  /** Transient LLM retries observed for this batch (reported by the client). */
  llmRetries: number
  /** The Claude breaker was open, so the LLM was skipped and everything fell back deterministically. */
  breakerOpen: boolean
}

/** generateExplanations result: the explained results plus the stats for this batch. */
export type ExplanationResult = {
  results: ResultWithExplanation[]
  stats: ExplanationStats
}

export type ExplanationDeps = {
  /** Omit to run in deterministic fallback-only mode (useful before an Anthropic key is wired). */
  client?: ExplanationClient
  /** Defaults to a process-local in-memory cache. Production injects a Supabase-backed adapter. */
  cache?: ExplanationCache
  /** Circuit breaker guarding the LLM call. Defaults to the shared claudeBreaker; inject in tests. */
  breaker?: CircuitBreaker
  logger?: Logger
}

// ─── Injectable collaborators ─────────────────────────────────────────────────

/**
 * Narrow LLM seam. Returns a map of contentId → explanation text for the requested batch. The optional
 * AbortSignal lets the orchestrator enforce a deadline; honoring it (cancelling in-flight work) is
 * encouraged but not required — the orchestrator also races a timeout, so the deadline holds regardless.
 */
export interface ExplanationClient {
  generate(
    items: ExplanationPromptItem[],
    context: ExplanationContext,
    signal?: AbortSignal,
    /** Called once per transient retry, so the orchestrator can surface a flakiness count in metrics. */
    onRetry?: () => void
  ): Promise<Map<string, string>>
}

/**
 * Minimal cache seam. Implementations may be sync (Map) or async (DB) — both are awaited.
 *
 * getMany/setMany are OPTIONAL batched variants: a DB-backed cache implements them to collapse N
 * per-title round-trips into one read + one write. When absent, the orchestrator parallelizes the
 * single-key get/set instead, so neither path is ever sequential. get/set remain the contract.
 */
export interface ExplanationCache {
  get(key: string): Promise<string | undefined> | string | undefined
  set(key: string, value: string): Promise<void> | void
  /** Batched read: returns only the keys present (and fresh). Misses are simply absent from the map. */
  getMany?(keys: string[]): Promise<Map<string, string>> | Map<string, string>
  /** Batched write: upserts all entries in one round-trip. */
  setMany?(entries: Array<{ key: string; value: string }>): Promise<void> | void
}

/** Compact, prompt-ready view of one candidate. Built from its ScoredCandidate + taste context. */
export type ExplanationPromptItem = {
  contentId: string
  title: string
  type: ContentType
  releaseYear: number | null
  genres: string[]
  moodTags: string[]
  descriptionExcerpt: string | null
  confidence: Confidence
  signals: SignalSummary
}

export type ExplanationContext = {
  queryText: string
  /** Titles the user loved/liked, for "you liked X" references. */
  likedTitles: string[]
}

/** Human-meaningful summary of a candidate's scoreBreakdown, used by both the prompt and the fallback. */
export type SignalSummary = {
  confidence: Confidence
  semanticMatch: 'strong' | 'solid' | 'loose'
  quality: 'acclaimed' | 'well-reviewed' | 'unknown'
  /** Present only when personalization is meaningfully above neutral AND a seed is clearly responsible. */
  affinity?: {
    seedTitle: string
    sentiment: TasteSeed['sentiment']
    sharedTags: string[]
  }
}

// ─── Pure helpers (exported for testing) ──────────────────────────────────────

/** Normalizes (trim → lowercase → collapse whitespace) then SHA-256-hex hashes a query string. */
export function hashQuery(queryText: string): string {
  const normalized = queryText.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Stable per-user cache key for an explanation: `content_id:query_hash[:taste_signature]`. The taste
 * signature is appended only when present, so seedless (non-personalized) explanations keep the
 * original shareable `content_id:query_hash` form. See the file header for why taste context is keyed.
 */
export function explanationCacheKey(contentId: string, queryHash: string, tasteSignature = ''): string {
  const base = `${contentId}:${queryHash}`
  return tasteSignature ? `${base}:${tasteSignature}` : base
}

/**
 * A stable fingerprint of the taste context that influences explanation text — the sorted set of
 * `seedId:sentiment` pairs, SHA-256-hashed (truncated). Order-independent so seed ordering can't
 * fragment the cache. Empty string when there are no seeds (explanations are then user-agnostic).
 */
export function tasteSignature(seeds: TasteSeed[]): string {
  if (seeds.length === 0) return ''
  const normalized = seeds
    .map((s) => `${s.content.id}:${s.sentiment}`)
    .sort()
    .join('|')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Whether a candidate is low-confidence. Reads the `confidence` field that scoreAndRank already
 * computed against SIMILARITY_FLOOR — the single source of truth — rather than recomputing the
 * threshold here, so the two can never drift. Exported for engine.ts / UI callers.
 */
export function isLowConfidence(result: ScoredCandidate): boolean {
  return result.confidence === 'low'
}

/**
 * Distills a ScoredCandidate's breakdown into phrasing-ready signals. The affinity field names the
 * single positive (loved/liked) seed most responsible for the personalization lift — but only when
 * personalization is meaningfully above neutral and that seed's tag overlap clears a floor, so we
 * never fabricate a "because you loved X" claim from a coincidental weak match.
 */
export function summarizeSignals(result: ScoredCandidate, tasteSeeds: TasteSeed[]): SignalSummary {
  const { vectorSimilarity, personalization, qualityScore } = result.scoreBreakdown

  const semanticMatch = vectorSimilarity >= 0.68 ? 'strong' : vectorSimilarity >= SIMILARITY_FLOOR ? 'solid' : 'loose'
  const quality = qualityScore >= 0.7 ? 'acclaimed' : qualityScore >= 0.45 ? 'well-reviewed' : 'unknown'

  const summary: SignalSummary = {
    confidence: result.confidence,
    semanticMatch,
    quality,
  }

  if (personalization > PERSONALIZATION_REFERENCE_THRESHOLD) {
    const affinity = topPositiveAffinity(result.content, tasteSeeds)
    if (affinity) summary.affinity = affinity
  }

  return summary
}

/** Builds the compact prompt view for a single result. */
export function buildPromptItem(result: ScoredCandidate, tasteSeeds: TasteSeed[]): ExplanationPromptItem {
  const c = result.content
  return {
    contentId: c.id,
    title: c.title,
    type: c.type,
    releaseYear: c.releaseYear,
    genres: c.genres,
    moodTags: c.moodTags,
    descriptionExcerpt: excerpt(c.description, DESCRIPTION_EXCERPT_CHARS),
    confidence: result.confidence,
    signals: summarizeSignals(result, tasteSeeds),
  }
}

/**
 * Deterministic, no-LLM explanation derived purely from the candidate's signals. Used for cache misses
 * when no client is available or the client fails. Low-confidence results are hedged honestly rather
 * than oversold, protecting the product's "confident but trustworthy" promise.
 */
export function buildFallbackExplanation(item: ExplanationPromptItem): string {
  const descriptor = describeTitle(item)
  const { signals } = item

  if (signals.confidence === 'low') {
    return `A bit outside your search, but ${item.title} is ${descriptor} that could still be worth a look.`
  }

  if (signals.affinity) {
    const shared = signals.affinity.sharedTags.slice(0, 2).join(' and ')
    const verb = signals.affinity.sentiment === 'loved' ? 'loved' : 'liked'
    const sharedClause = shared ? ` — same ${shared} feel` : ''
    return `Because you ${verb} ${signals.affinity.seedTitle}, ${item.title} should land${sharedClause}. A ${signals.semanticMatch} match for what you asked for.`
  }

  const qualityClause = signals.quality === 'acclaimed' ? ' and widely acclaimed' : signals.quality === 'well-reviewed' ? ' and well-reviewed' : ''
  return `A ${signals.semanticMatch} match for your search — ${descriptor}${qualityClause}.`
}

// ─── Claude Haiku client ──────────────────────────────────────────────────────

// Minimal structural type for the one Anthropic SDK method we use — avoids coupling to its full shape.
// `system` is typed as the SDK expects (string or cacheable text blocks) so the real client is assignable.
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
type AnthropicLike = {
  messages: {
    create(
      body: {
        model: string
        max_tokens: number
        system?: string | SystemBlock[]
        messages: { role: 'user'; content: string }[]
      },
      options?: { signal?: AbortSignal }
    ): Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

const responseSchema = z.array(z.object({ content_id: z.string(), explanation: z.string().min(1) }))

const SYSTEM_PROMPT =
  'You write recommendation explanations for a calm, intelligent streaming app that helps people decide what to watch. ' +
  'For each title, write ONE warm, specific sentence (max ~35 words) on why THIS title fits the request and taste. ' +
  'Anchor it in something concrete and distinctive about the title — a specific plot hook, premise, tone, or what sets ' +
  'it apart — drawn from its plot/genres/mood, not vague praise. Connect that to the user\'s query (or a title they loved) ' +
  'so the reason feels tailored, not generic. ' +
  'BANNED as filler: "a great show/film", "a strong match", "you\'ll love it", "perfect for you", "a must-watch", and ' +
  'restating the genre alone. Vary how each sentence opens — do not start them all the same way. ' +
  'If a title is marked low-confidence, hedge honestly ("might appeal", "could work if…") rather than overpromising. ' +
  'Respond ONLY with a JSON array: [{"content_id": "...", "explanation": "..."}].'

/**
 * Claude-Haiku-backed ExplanationClient. Batches all items into a single call, validates the JSON
 * response, and retries transient failures. The static system prompt is sent as a cacheable block so
 * repeated calls hit Anthropic's prompt cache. Throws ExplanationError('GENERATION_FAILED') on
 * exhausted retries — the orchestrator catches this and falls back, so it never reaches the user.
 */
export function createClaudeExplanationClient(anthropic: AnthropicLike, logger: Logger = noopLogger): ExplanationClient {
  return {
    async generate(items, context, signal, onRetry): Promise<Map<string, string>> {
      if (items.length === 0) return new Map()
      const userPrompt = buildUserPrompt(items, context)

      let lastErr: unknown
      for (let attempt = 0; attempt <= EXPLAIN_MAX_RETRIES; attempt++) {
        try {
          const res = await anthropic.messages.create(
            {
              model: EXPLAIN_MODEL,
              max_tokens: EXPLAIN_MAX_TOKENS,
              system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
              messages: [{ role: 'user', content: userPrompt }],
            },
            signal ? { signal } : undefined
          )
          const text = res.content.find((b) => b.type === 'text')?.text ?? ''
          const parsed = responseSchema.parse(JSON.parse(extractJsonArray(text)))
          return new Map(parsed.map((r) => [r.content_id, r.explanation.trim()]))
        } catch (err) {
          lastErr = err
          // The deadline fired and aborted the request — don't burn retries against a dead signal.
          if (signal?.aborted) break
          if (attempt < EXPLAIN_MAX_RETRIES) {
            const delay = 500 * 2 ** attempt
            onRetry?.()
            logger.warn('explanation generation attempt failed — retrying', { attempt: attempt + 1, delayMs: delay })
            await sleep(delay)
          }
        }
      }
      throw new ExplanationError('GENERATION_FAILED', 'failed to generate explanations after retries', lastErr)
    },
  }
}

/** Process-local cache. Adequate for the thin slice; swap for a Supabase adapter in production. */
export function createInMemoryExplanationCache(): ExplanationCache {
  const store = new Map<string, string>()
  return {
    get: (key) => store.get(key),
    set: (key, value) => void store.set(key, value),
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Attaches an explanation to every result, in the input order. Reuses cached explanations, batches a
 * single LLM call for the rest, and falls back deterministically for anything the LLM didn't (or
 * couldn't) produce. Never throws on generation failure — recommendations must not be blocked by the
 * explanation layer.
 *
 * @throws ExplanationError('INVALID_INPUT') on malformed input only.
 */
export async function generateExplanations(
  input: ExplanationInput,
  deps: ExplanationDeps = {}
): Promise<ExplanationResult> {
  const logger = deps.logger ?? noopLogger
  if (!Array.isArray(input.results)) {
    throw new ExplanationError('INVALID_INPUT', 'results must be an array')
  }
  if (!input.queryText?.trim()) {
    throw new ExplanationError('INVALID_INPUT', 'queryText must be a non-empty string')
  }
  if (input.results.length === 0) {
    return {
      results: [],
      stats: { total: 0, cacheHits: 0, cacheMisses: 0, llmUsed: false, fallbackCount: 0, deadlineHit: false, llmError: false, llmRetries: 0, breakerOpen: false },
    }
  }

  const cache = deps.cache ?? createInMemoryExplanationCache()
  const seeds = input.tasteSeeds ?? []
  const queryHash = input.queryHash ?? hashQuery(input.queryText)
  const signature = tasteSignature(seeds)

  const items = input.results.map((r) => buildPromptItem(r, seeds))
  const keyOf = (item: ExplanationPromptItem): string => explanationCacheKey(item.contentId, queryHash, signature)

  // 1) Resolve from cache. Reads are issued as ONE batched round-trip (getMany) when the cache supports
  //    it, else fanned out in parallel — never one sequential await per title, which on a DB-backed
  //    cache would be N round-trips on the hot path.
  const explanations = new Map<string, string>()
  const cached = await readFromCache(cache, items.map(keyOf))
  const uncached: ExplanationPromptItem[] = []
  for (const item of items) {
    const hit = cached.get(keyOf(item))
    if (hit) explanations.set(item.contentId, hit)
    else uncached.push(item)
  }

  const cacheHits = items.length - uncached.length

  // 2) Generate the rest in one batched LLM call — best-effort, under a wall-clock DEADLINE. If the call
  //    errors OR exceeds EXPLANATION_DEADLINE_MS, we leave those items to the deterministic fallback in
  //    step 3 (a slow Haiku call must not stall the response). Un-applied items are then counted as
  //    fallbacks via llmGenerated below — including deadline-skipped ones.
  const breaker = deps.breaker ?? claudeBreaker
  let llmUsed = false
  let deadlineHit = false
  let llmError = false
  let llmRetries = 0
  let breakerOpen = false
  if (uncached.length > 0 && deps.client) {
    if (!(await breaker.allow())) {
      // Breaker open: skip Claude entirely and fall through to deterministic fallbacks (fast, no 3s wait).
      breakerOpen = true
      logger.warn('claude circuit breaker open — skipping LLM, using deterministic fallbacks', { count: uncached.length })
    } else {
      llmUsed = true
      const context: ExplanationContext = { queryText: input.queryText, likedTitles: likedTitlesOf(seeds) }
      try {
        const generated = await generateWithDeadline(deps.client, uncached, context, EXPLANATION_DEADLINE_MS, () => {
          llmRetries++
        })
        if (generated === DEADLINE) {
          deadlineHit = true
          logger.warn('explanation generation exceeded deadline — using deterministic fallbacks', {
            deadlineMs: EXPLANATION_DEADLINE_MS,
            count: uncached.length,
          })
        } else {
          for (const item of uncached) {
            const text = generated.get(item.contentId)
            if (text) explanations.set(item.contentId, text)
          }
        }
      } catch (err) {
        llmError = true
        logger.error('explanation generation failed — using deterministic fallbacks', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
      // Feed the resilience signals back into the breaker: a timeout or error is a failure, else success.
      if (deadlineHit || llmError) await breaker.recordFailure()
      else await breaker.recordSuccess()
    }
  }

  // Entries the LLM actually produced = everything in the map beyond the cache hits. Captured BEFORE
  // the fallback fill below, so the fallback count is exact.
  const llmGenerated = explanations.size - cacheHits

  // 3) Persist genuine LLM output, then fill gaps with deterministic fallbacks. Fallbacks are NOT
  //    cached (C2): a transient outage must not poison the cache with degraded text for the TTL.
  //    Writes are collected and flushed in ONE batched round-trip (setMany), else parallelized — same
  //    reason as the reads above.
  const toCache: Array<{ key: string; value: string }> = []
  for (const item of uncached) {
    if (explanations.has(item.contentId)) {
      toCache.push({ key: keyOf(item), value: explanations.get(item.contentId)! })
    } else {
      explanations.set(item.contentId, buildFallbackExplanation(item))
    }
  }
  await writeToCache(cache, toCache)

  const stats: ExplanationStats = {
    total: items.length,
    cacheHits,
    cacheMisses: uncached.length,
    llmUsed,
    fallbackCount: uncached.length - llmGenerated,
    deadlineHit,
    llmError,
    llmRetries,
    breakerOpen,
  }
  logger.debug('explanations attached', { ...stats })

  return {
    results: input.results.map((r) => ({ ...r, explanation: explanations.get(r.content.id)! })),
    stats,
  }
}

// ─── internal helpers ─────────────────────────────────────────────────────────

/** Sentinel returned by generateWithDeadline when the LLM call exceeds its budget. */
const DEADLINE = Symbol('explanation-deadline')

/**
 * Runs the batched LLM call under a wall-clock deadline. Returns the client's result if it finishes in
 * time, or the DEADLINE sentinel once `ms` elapses — in which case it also aborts the in-flight request
 * (clients honoring the signal stop work; the Promise.race guarantees we stop waiting regardless). A
 * genuine rejection propagates to the caller's catch (the existing error-fallback path).
 */
async function generateWithDeadline(
  client: ExplanationClient,
  items: ExplanationPromptItem[],
  context: ExplanationContext,
  ms: number,
  onRetry?: () => void
): Promise<Map<string, string> | typeof DEADLINE> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(DEADLINE)
    }, ms)
  })

  const generated = client.generate(items, context, controller.signal, onRetry)
  generated.catch(() => {}) // swallow a late rejection (e.g. abort) once the deadline has won the race

  try {
    return await Promise.race([generated, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Hot-path contract: with a batched cache (getMany/setMany — e.g. the Supabase adapter) one request
// makes AT MOST 2 cache round-trips total — one read here + one write in writeToCache — independent of
// result-set size (and exactly 1 when every title is cached, since there's nothing to write).

/**
 * Batched cache read. Resolves all keys in a SINGLE round-trip via getMany when the cache provides it;
 * otherwise falls back to firing the single-key gets concurrently (Promise.all). Either strategy avoids
 * the N sequential awaits that a per-title loop would incur — the whole point of this helper. Fail-open
 * is the cache's own responsibility: misses (and any errors it swallows) are simply absent from the map.
 */
async function readFromCache(cache: ExplanationCache, keys: string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map()
  if (cache.getMany) return cache.getMany(keys)
  const values = await Promise.all(keys.map((k) => cache.get(k)))
  const out = new Map<string, string>()
  keys.forEach((k, i) => {
    const v = values[i]
    if (v) out.set(k, v)
  })
  return out
}

/**
 * Batched cache write — the second half of the at-most-2-round-trips contract above. Persists all freshly
 * generated explanations in a SINGLE round-trip via setMany when the cache provides it; otherwise falls
 * back to firing the single-key sets concurrently (Promise.all), never sequentially. No-op for an empty
 * batch (nothing generated → zero writes), so a fully-cached request stays at one total round-trip.
 */
async function writeToCache(cache: ExplanationCache, entries: Array<{ key: string; value: string }>): Promise<void> {
  if (entries.length === 0) return
  if (cache.setMany) {
    await cache.setMany(entries)
    return
  }
  await Promise.all(entries.map((e) => cache.set(e.key, e.value)))
}

function topPositiveAffinity(candidate: ContentRow, seeds: TasteSeed[]): SignalSummary['affinity'] | undefined {
  let best: { seed: TasteSeed; overlap: number } | undefined
  for (const seed of seeds) {
    if (seed.sentiment === 'disliked') continue
    const overlap = tagOverlap(candidate, seed.content)
    if (overlap >= AFFINITY_NAMING_THRESHOLD && (!best || overlap > best.overlap)) {
      best = { seed, overlap }
    }
  }
  if (!best) return undefined
  return {
    seedTitle: best.seed.content.title,
    sentiment: best.seed.sentiment,
    sharedTags: sharedTags(candidate, best.seed.content),
  }
}

function sharedTags(a: ContentRow, b: ContentRow): string[] {
  const bSet = new Set([...b.genres, ...b.moodTags, ...b.themeTags].map((t) => t.trim().toLowerCase()))
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of [...a.genres, ...a.moodTags, ...a.themeTags]) {
    const norm = tag.trim().toLowerCase()
    if (norm && bSet.has(norm) && !seen.has(norm)) {
      seen.add(norm)
      out.push(tag)
    }
  }
  return out
}

function describeTitle(item: ExplanationPromptItem): string {
  const kind = item.type === 'movie' ? 'film' : 'series'
  const genre = item.genres[0]?.toLowerCase()
  return genre ? `a ${genre} ${kind}` : `a ${kind}`
}

function likedTitlesOf(seeds: TasteSeed[]): string[] {
  return seeds.filter((s) => s.sentiment !== 'disliked').map((s) => s.content.title)
}

function buildUserPrompt(items: ExplanationPromptItem[], context: ExplanationContext): string {
  const lines: string[] = [`User query: "${context.queryText}"`]
  if (context.likedTitles.length > 0) {
    lines.push(`Titles the user likes: ${context.likedTitles.join(', ')}.`)
  }
  lines.push('', 'Titles to explain:')
  for (const item of items) {
    const parts = [
      `[${item.contentId}] ${item.title}${item.releaseYear ? ` (${item.releaseYear})` : ''}`,
      `${item.type}; genres: ${item.genres.join(', ') || 'n/a'}; mood: ${item.moodTags.join(', ') || 'n/a'}`,
      `match: ${item.signals.semanticMatch}; quality: ${item.signals.quality}; confidence: ${item.confidence}`,
    ]
    if (item.signals.affinity) {
      parts.push(`taste link: user ${item.signals.affinity.sentiment} "${item.signals.affinity.seedTitle}" (shared: ${item.signals.affinity.sharedTags.join(', ') || 'theme'})`)
    }
    if (item.descriptionExcerpt) parts.push(`plot: ${item.descriptionExcerpt}`)
    lines.push(parts.join(' | '))
  }
  return lines.join('\n')
}

function extractJsonArray(text: string): string {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return text
  return text.slice(start, end + 1)
}

function excerpt(text: string | null, max: number): string | null {
  if (!text) return null
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
