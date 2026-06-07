// Engine — thin orchestrator for the recommendation pipeline.
//
// Wires the five steps together: load taste seeds → retrieve → hard-filter → score → explain →
// attach where-to-watch. Each step lives in its own module and is unaware of the others; this file
// only sequences them and adapts data between the DB and the pure cores.
//
// Design decisions:
//   • Dependency injection mirrors the rest of the engine: the Supabase client, the embedding client,
//     and the (optional) explanation client/cache are all injected via EngineDeps, so this is testable
//     with fakes and has no hidden globals. The explanation client/cache are optional — omit them and
//     explanations degrade to deterministic fallbacks (see explanations.ts), which lets the thin
//     vertical slice run before an Anthropic key or a persistent cache exists.
//   • Taste seeds may be passed in directly (tasteSeeds) OR loaded from a userId. Passing them in
//     bypasses the DB — convenient for tests and for callers that already hold the seeds.
//   • queryHash is computed ONCE here (hashQuery) and threaded into generateExplanations, so the
//     explanation cache key matches the value an API route would persist as the session's intent hash.
//   • We slice to the FINAL result count BEFORE generating explanations, not after. The original doc
//     explained the top ~20 then cut to ~8; that wastes LLM tokens on results we never show. With no
//     re-ranking step between scoring and display, scoring's order is final, so explaining only the
//     top N is correct and cheaper. Raise EXPLANATION_HEADROOM later if a re-rank step is added.
//   • Platform/deep-link data is re-queried for the final results (filters.ts verifies availability
//     but discards the rows). One batched query over ≤N ids — acceptable for the slice. A future
//     optimization is to have filters.ts carry the offers through and skip this round-trip.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type ContentType, parseContentRow } from '@/lib/types/content'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { type TasteSeed, tasteSentimentSchema } from '@/lib/types/taste'
import { type EmbeddingClient, retrieveCandidates, DEFAULT_CANDIDATE_LIMIT } from '@/lib/recommendations/retrieval'
import { applyHardFilters } from '@/lib/recommendations/filters'
import { type ParsedIntent, PLATFORM_SLUGS, parseQueryConstraints } from '@/lib/recommendations/intent'
import { type ScoreWeights, type ScoredCandidate, DEFAULT_SCORE_WEIGHTS, scoreAndRank } from '@/lib/recommendations/scoring'
import { type TasteProfile, emptyTasteProfile, forYouEmbedQuery, loadTasteProfile } from '@/lib/recommendations/taste-profile'
import { NEUTRAL_AFFINITY } from '@/lib/onboarding/categories'
import { loadSeenContentIds } from '@/lib/recommendations/interactions'
import { type UserDefaults, loadUserDefaults } from '@/lib/recommendations/user-defaults'
import {
  type ExplanationCache,
  type ExplanationClient,
  type ExplanationStats,
  type ResultWithExplanation,
  generateExplanations,
  hashQuery,
} from '@/lib/recommendations/explanations'
import { type RecommendationPipelineMetrics, startTimer } from '@/lib/utils/observability'

// ─── Tunables ─────────────────────────────────────────────────────────────────

const DEFAULT_REGION = 'us'
const DEFAULT_RESULT_LIMIT = 8
const MAX_RESULT_LIMIT = 12

/** How many candidates retrieval pulls before filtering. Filtering + scoring trim from here. */
const RETRIEVAL_LIMIT = DEFAULT_CANDIDATE_LIMIT

// Explicit content columns for taste-seed loads — never `*`, to avoid pulling the 512-dim embedding.
const CONTENT_COLUMNS = [
  'id', 'tmdb_id', 'title', 'type', 'release_year', 'description',
  'genres', 'mood_tags', 'theme_tags', 'cast_names', 'director_names',
  'runtime_minutes', 'avg_episode_minutes', 'season_count',
  'imdb_rating', 'tmdb_rating', 'tmdb_vote_count',
  'poster_url', 'backdrop_url', 'original_language', 'content_rating',
].join(', ')

// ─── Errors ───────────────────────────────────────────────────────────────────

export type EngineErrorCode = 'INVALID_INPUT' | 'TASTE_LOAD_FAILED' | 'PLATFORM_LOAD_FAILED'

export class EngineError extends Error {
  readonly code: EngineErrorCode
  override readonly cause?: unknown
  constructor(code: EngineErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.cause = cause
  }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

export type RecommendationMode = 'search' | 'for-you'

export type RecommendationQuery = {
  /** The user's search text. Required for mode 'search'; ignored for 'for-you' (no query). */
  queryText: string
  /**
   * 'search' (default) = embed the user's query. 'for-you' = no query: embed a taste-derived query from
   * the TasteProfile and rank by category affinity. Same pipeline, same scoring — just a different seed.
   */
  recommendationMode?: RecommendationMode
  /** If given (and tasteSeeds is not), seeds are loaded from user_taste_seeds. */
  userId?: string
  /** Pre-loaded seeds. Takes precedence over userId, bypassing the DB. */
  tasteSeeds?: TasteSeed[]
  /** Pre-loaded category-affinity profile. Takes precedence over userId loading (tests inject this). */
  tasteProfile?: TasteProfile
  /** Score weights to apply, flag/config-resolved by the caller. Defaults to DEFAULT_SCORE_WEIGHTS. Both
   *  recommendation routes MUST resolve these identically so the deferred-explanation re-run matches the grid. */
  scoreWeights?: ScoreWeights
  /** Platform slugs the user can watch (e.g. ['netflix','prime']). Empty = no platform gate. */
  platformSlugs?: string[]
  region?: string
  contentType?: ContentType
  maxRuntimeMinutes?: number
  excludeContentIds?: string[]
  /**
   * When true (and the caller has a session), drop titles the user has marked seen (any SEEN_ACTIONS) from
   * the results — the discovery "Exclude seen films" toggle. A HARD, explicit filter (never relaxed). Uses
   * the same seen source as the alreadySeen stamp, loaded once.
   */
  excludeSeen?: boolean
  /**
   * Genres to NOT exclude, even if parsed intent or onboarding defaults would have. Lets the UI relax a
   * specific soft genre exclusion (e.g. the user clicks the "Excluding: Romance" chip to add it back).
   * Case-insensitive. This can only BROADEN results — it never adds a hard filter — so it's safe to accept
   * from the client.
   */
  allowGenres?: string[]
  /** Final number of recommendations to return. Defaults to 8, capped at 12. */
  limit?: number
  /**
   * When false, skip explanation generation entirely — results come back without "why this" text and
   * the caller fetches explanations separately (e.g. for the detail modal). Default true, so existing
   * callers and tests are unchanged.
   */
  withExplanations?: boolean
  /**
   * When false, skip the best-effort session write. The deferred-explanations endpoint re-runs this
   * pipeline purely to produce explanations for an already-recorded search, so it sets this false to
   * avoid a duplicate session row. Default true.
   */
  recordSession?: boolean
  /**
   * When false, skip the `alreadySeen` lookup (one query). The deferred-explanations re-run discards the
   * recommendation objects, so it has no use for the stamp. Default true.
   */
  stampAlreadySeen?: boolean
}

/** Where a title can be watched on one of the user's platforms. */
export type PlatformOffer = {
  slug: string
  name: string
  deepLink: string | null
  streamingType: string | null
}

export type Recommendation = ResultWithExplanation & {
  /**
   * Where to watch: one entry per platform the title is currently available on in the region.
   * Limited to the user's platforms when platformSlugs is provided; otherwise all platforms.
   */
  platforms: PlatformOffer[]
  /** True when the user has marked this title seen (any SEEN_ACTIONS interaction). Drives the
   *  "Already seen" badge and is the shared signal behind the global Seen/Not-Seen filter. */
  alreadySeen: boolean
}

/**
 * The constraints actually applied to this request (after merging API params + parsed intent and any
 * relaxation). Surfaced so the UI can render them as chips ("Only on Netflix", "Excluding: horror").
 */
export type AppliedConstraints = {
  contentType?: ContentType
  maxRuntimeMinutes?: number
  originalLanguage?: string
  /** Effective platform allow-set results were limited to ([] = no platform gate). */
  platforms: string[]
  /** Empty if there were none, or if they were relaxed to avoid an empty result set. */
  excludeGenres: string[]
  /** True when genre exclusions were dropped because they would have returned nothing. */
  genreExclusionsRelaxed: boolean
}

export type RecommendationResponse = {
  recommendations: Recommendation[]
  appliedConstraints: AppliedConstraints
  /** Per-request pipeline metrics (timings, cache stats, funnel, coverage). Logged, never returned to
   *  the client. */
  metrics: RecommendationPipelineMetrics
}

export type EngineDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>
  embeddingClient: EmbeddingClient
  /** Omit to use deterministic fallback explanations (no LLM). */
  explanationClient?: ExplanationClient
  /** Omit to use a per-request in-memory cache (no cross-request reuse). */
  explanationCache?: ExplanationCache
  logger?: Logger
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Runs the full recommendation pipeline for one query and returns the top results, each scored,
 * explained, and annotated with where to watch.
 *
 * @throws EngineError('INVALID_INPUT') on bad input; RetrievalError / FilterError / EngineError from
 *         the underlying steps propagate with their own codes.
 */
export async function getRecommendations(
  query: RecommendationQuery,
  deps: EngineDeps
): Promise<RecommendationResponse> {
  const logger = deps.logger ?? noopLogger

  const mode: RecommendationMode = query.recommendationMode ?? 'search'
  const queryText = query.queryText?.trim() ?? ''
  if (mode === 'search' && !queryText) {
    throw new EngineError('INVALID_INPUT', 'queryText must be a non-empty string')
  }

  const region = query.region?.trim() || DEFAULT_REGION
  const limit = clampLimit(query.limit)
  const withExplanations = query.withExplanations ?? true
  const recordSession = query.recordSession ?? true
  const stampSeen = query.stampAlreadySeen ?? true

  // 0) Parse structured intent (negatives + positives) from the query. For 'for-you' there's no user
  //    query, so intent is empty (the embed query is synthesized from the taste profile below).
  const intent = parseQueryConstraints(queryText)

  // 1) Load this user's signals in parallel:
  //    • tasteSeeds — liked/disliked swipes → drive RANKING (computePersonalization), never filtering.
  //    • userDefaults — onboarding answers → default FILTERS, applied only where unspecified this session.
  const [tasteSeeds, userDefaults, tasteProfile] = await Promise.all([
    query.tasteSeeds
      ? Promise.resolve(query.tasteSeeds)
      : query.userId
        ? loadTasteSeeds(query.userId, deps.supabase, logger)
        : Promise.resolve([] as TasteSeed[]),
    query.userId ? loadUserDefaults(query.userId, deps.supabase, logger) : Promise.resolve({} as UserDefaults),
    // Category-affinity prior (the onboarding swipe signal). Anonymous-with-profile users have one too.
    query.tasteProfile
      ? Promise.resolve(query.tasteProfile)
      : query.userId
        ? loadTasteProfile(query.userId, deps.supabase, { logger })
        : Promise.resolve(emptyTasteProfile()),
  ])

  // Resolve the text we actually embed + the cache namespace, by mode:
  //   • search  → the intent-cleaned user query (the explanation cache key hashes the ORIGINAL query).
  //   • for-you → a TEMPORARY synthetic query from the taste profile (see forYouEmbedQuery's TODO on the
  //               centroid-retrieval migration path). Namespaced ('for-you:') so it can't collide with a
  //               user typing the same words.
  const embedQuery = mode === 'for-you' ? forYouEmbedQuery(tasteProfile) : intent.cleanedQuery || queryText
  const recordedQuery = mode === 'for-you' ? embedQuery : queryText
  const queryHash = hashQuery(mode === 'for-you' ? `for-you:${embedQuery}` : queryText)

  // Merge constraints. PRECEDENCE: explicit API param  >  parsed query intent  >  onboarding default.
  // Onboarding answers only fill gaps the user didn't specify this session, so a per-query choice (or
  // a phrase like "only series") always wins over a standing default — they're defaults, not settings.
  const requestedPlatforms =
    query.platformSlugs && query.platformSlugs.length > 0 ? query.platformSlugs : userDefaults.platformSlugs ?? []
  const platformSlugs = resolvePlatformAllowSet(requestedPlatforms, intent.includePlatforms, intent.excludePlatforms)
  const contentType = query.contentType ?? intent.contentType ?? userDefaults.contentType
  const maxRuntimeMinutes = query.maxRuntimeMinutes ?? intent.maxRuntimeMinutes ?? userDefaults.maxRuntimeMinutes
  const originalLanguage = intent.originalLanguage

  // Genre exclusions combine this-session negatives with the onboarding avoid-list (deduped), minus any
  // the caller explicitly allowed back in (allowGenres — the UI's "un-click this filter" action). This is
  // a SOFT exclusion: it's relaxed below if it would empty results, and (via protectContentIds) it never
  // hides a title the user explicitly liked.
  const allowGenres = new Set((query.allowGenres ?? []).map((g) => g.trim().toLowerCase()))
  const excludeGenres = [...new Set([...intent.excludeGenres, ...(userDefaults.excludeGenres ?? [])])].filter(
    (g) => !allowGenres.has(g.trim().toLowerCase())
  )
  const likedContentIds = tasteSeeds.filter((s) => s.sentiment !== 'disliked').map((s) => s.content.id)

  // 2) Retrieve (cleaned query) → 3) hard-filter (positive + negative constraints). Each stage is
  //    timed; the durations roll up into the request's single observability event (emitted by the route).
  const retrieveTimer = startTimer()
  const candidates = await retrieveCandidates(
    { queryText: embedQuery, limit: RETRIEVAL_LIMIT },
    { supabase: deps.supabase, embeddingClient: deps.embeddingClient, logger }
  )
  const retrieveMs = retrieveTimer()

  // Load the user's SEEN set ONCE (among the retrieved candidates) — reused for BOTH the excludeSeen filter
  // and the alreadySeen stamp below, so there's a single query and no duplicated seen-loading. Empty for
  // anonymous callers or when neither use is needed. (stampSeen is resolved near the top of the pipeline.)
  const excludeSeen = query.excludeSeen ?? false
  const candidateIds = candidates.map((c) => c.content.id)
  const seenIds =
    query.userId && (excludeSeen || stampSeen)
      ? await loadSeenContentIds(query.userId, candidateIds, deps.supabase, logger)
      : new Set<string>()

  // excludeSeen folds the seen ids into the hard exclusion list (filterByExclusions handles it).
  const excludeContentIds = excludeSeen
    ? [...new Set([...(query.excludeContentIds ?? []), ...seenIds])]
    : query.excludeContentIds

  const filterInput = {
    candidates,
    platformSlugs,
    region,
    contentType,
    maxRuntimeMinutes,
    excludeContentIds,
    excludeGenres,
    protectContentIds: likedContentIds,
    originalLanguage,
  }
  const filterTimer = startTimer()
  let filtered = await applyHardFilters(filterInput, { supabase: deps.supabase, logger })

  // Guardrail: genre exclusions are "soft" — if they leave nothing, relax them so we still return
  // results. Platform/type/runtime/language are explicit asks and stay hard.
  let genreExclusionsRelaxed = false
  if (filtered.length === 0 && excludeGenres.length > 0) {
    logger.warn('relaxing genre exclusions — they left no results', { excludeGenres })
    filtered = await applyHardFilters({ ...filterInput, excludeGenres: [] }, { supabase: deps.supabase, logger })
    genreExclusionsRelaxed = true
  }
  const filterMs = filterTimer()

  // 4) Score, then slice to the final count before the (costly) explanation step. The category-affinity
  //    prior re-ranks toward the user's onboarding taste; weights are flag/config-resolved by the route
  //    (categoryAffinity weight → 0 when the kill-switch is off).
  const scoreTimer = startTimer()
  const scoreWeights = query.scoreWeights ?? DEFAULT_SCORE_WEIGHTS
  const ranked = scoreAndRank(
    { candidates: filtered, tasteSeeds, categoryAffinities: tasteProfile.categoryAffinities, weights: scoreWeights },
    { logger }
  )
  const top = ranked.slice(0, limit)
  const scoreMs = scoreTimer()

  // 5) Explanations (best-effort; degrades to fallbacks). Skipped in DEFERRED mode (withExplanations
  //    false): results return without "why this" text and the caller fetches explanations separately,
  //    so the grid isn't blocked on the LLM. The original query drives phrasing / the cache key.
  const explainTimer = startTimer()
  let explained: ResultWithExplanation[]
  let explanationStats: ExplanationStats
  if (withExplanations) {
    const r = await generateExplanations(
      { results: top, queryText: recordedQuery, queryHash, tasteSeeds },
      { client: deps.explanationClient, cache: deps.explanationCache, logger }
    )
    explained = r.results
    explanationStats = r.stats
  } else {
    explained = top.map((r) => ({ ...r, explanation: '' }))
    explanationStats = {
      total: top.length,
      cacheHits: 0,
      cacheMisses: 0,
      llmUsed: false,
      fallbackCount: 0,
      deadlineHit: false,
      llmError: false,
      llmRetries: 0,
      breakerOpen: false,
    }
  }
  const explainMs = explainTimer()

  // 6) Attach where-to-watch. The already-seen stamp reuses the seen set loaded once above (final ids are a
  //    subset of the candidates we looked up), so there's no second seen query here.
  const offersTimer = startTimer()
  const finalIds = explained.map((r) => r.content.id)
  const offers = await loadPlatformOffers(finalIds, platformSlugs, region, deps.supabase, logger)
  const offersMs = offersTimer()
  const recommendations: Recommendation[] = explained.map((r) => ({
    ...r,
    platforms: offers.get(r.content.id) ?? [],
    alreadySeen: seenIds.has(r.content.id),
  }))

  const appliedConstraints: AppliedConstraints = {
    contentType,
    maxRuntimeMinutes,
    originalLanguage,
    platforms: platformSlugs,
    excludeGenres: genreExclusionsRelaxed ? [] : excludeGenres,
    genreExclusionsRelaxed,
  }

  // 7) Persist the session (best-effort; never blocks or throws). Skipped when recordSession is false
  //    (the deferred-explanations re-run, to avoid a duplicate row for an already-recorded search).
  if (recordSession) {
    await persistSession(
      deps.supabase,
      {
        userId: query.userId,
        queryText: recordedQuery,
        parsedIntent: intent,
        platformFilters: platformSlugs,
        contentType,
        resultCount: recommendations.length,
      },
      logger
    )
  }

  // Assemble pipeline metrics from values already computed above — pure object construction over
  // numbers/booleans, so it cannot throw. The route stamps requestId + totalMs + outcome and emits the
  // single structured event.
  const ratedReturned = recommendations.filter((r) => r.content.blendedRating != null).length
  // Category-affinity lift signals — measured over the RETURNED set so we can compare flag on/off.
  const affinityValues = recommendations.map((r) => r.scoreBreakdown.categoryAffinity)
  const affinityInfluencedCount = affinityValues.filter((a) => Math.abs(a - NEUTRAL_AFFINITY) > 1e-6).length
  const avgCategoryAffinity =
    affinityValues.length > 0
      ? Math.round((affinityValues.reduce((s, a) => s + a, 0) / affinityValues.length) * 1000) / 1000
      : NEUTRAL_AFFINITY
  const metrics: RecommendationPipelineMetrics = {
    stages: { retrieveMs, filterMs, scoreMs, explainMs, offersMs },
    personalization: {
      categoryAffinityApplied: scoreWeights.categoryAffinity > 0,
      categoryAffinityWeight: scoreWeights.categoryAffinity,
      hasTasteProfile: tasteProfile.categoryAffinities.size > 0,
      affinityInfluencedCount,
      avgCategoryAffinity,
    },
    explanation: {
      cacheHits: explanationStats.cacheHits,
      cacheMisses: explanationStats.cacheMisses,
      llmUsed: explanationStats.llmUsed,
      fallbackCount: explanationStats.fallbackCount,
      deadlineHit: explanationStats.deadlineHit,
      llmError: explanationStats.llmError,
      llmRetries: explanationStats.llmRetries,
      breakerOpen: explanationStats.breakerOpen,
    },
    funnel: {
      retrieved: candidates.length,
      filtered: filtered.length,
      returned: recommendations.length,
      zeroResult: recommendations.length === 0,
      genreExclusionsRelaxed,
    },
    blendedCoverage:
      recommendations.length > 0 ? Math.round((ratedReturned / recommendations.length) * 100) / 100 : 0,
  }

  return { recommendations, appliedConstraints, metrics }
}

/**
 * Resolves platform intent into the positive allow-set the platform gate expects, combining the
 * caller's requested platforms, positive inclusions ("on Netflix"), and exclusions ("not on Disney"):
 *   • positive inclusions present → start from those (intersected with requested, if any)
 *   • else requested present → start from those
 *   • else exclusions present → start from all platforms
 *   • else → empty (no gate)
 * then subtract the exclusions.
 */
function resolvePlatformAllowSet(requested: string[], included: string[], excluded: string[]): string[] {
  let base: string[]
  if (included.length > 0) {
    base = requested.length > 0 ? included.filter((s) => requested.includes(s)) : included
  } else if (requested.length > 0) {
    base = requested
  } else if (excluded.length > 0) {
    base = [...PLATFORM_SLUGS]
  } else {
    base = []
  }
  const ex = new Set(excluded)
  return base.filter((slug) => !ex.has(slug))
}

/** Best-effort session write. Failures (e.g. RLS for anonymous users) are logged, never thrown. */
async function persistSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  params: {
    userId?: string
    queryText: string
    parsedIntent: ParsedIntent
    platformFilters: string[]
    contentType?: ContentType
    resultCount: number
  },
  logger: Logger
): Promise<void> {
  try {
    const { error } = await supabase.from('recommendation_sessions').insert({
      user_id: params.userId ?? null,
      query_text: params.queryText,
      parsed_intent: params.parsedIntent,
      platform_filters: params.platformFilters,
      content_type: params.contentType ?? 'any',
      result_count: params.resultCount,
    })
    if (error) logger.warn('session persist skipped (non-fatal)', { message: error.message })
  } catch (err) {
    logger.warn('session persist threw (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── Data-loading helpers (exported for testing) ──────────────────────────────

/**
 * Loads a user's onboarding ratings as TasteSeeds, each carrying the full ContentRow (genres/tags for
 * scoring, title for explanations). Malformed rows are skipped, not fatal — one bad seed shouldn't
 * sink a request.
 */
export async function loadTasteSeeds(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  logger: Logger = noopLogger
): Promise<TasteSeed[]> {
  const { data, error } = await supabase
    .from('user_taste_seeds')
    .select(`sentiment, content(${CONTENT_COLUMNS})`)
    .eq('user_id', userId)

  if (error) {
    throw new EngineError('TASTE_LOAD_FAILED', `failed to load taste seeds: ${error.message}`, error)
  }

  const seeds: TasteSeed[] = []
  for (const row of (data ?? []) as unknown as Array<{ sentiment: unknown; content: Record<string, unknown> | null }>) {
    const sentiment = tasteSentimentSchema.safeParse(row.sentiment)
    if (!sentiment.success || !row.content) {
      logger.warn('skipping malformed taste seed', { userId })
      continue
    }
    try {
      seeds.push({ sentiment: sentiment.data, content: parseContentRow(row.content) })
    } catch {
      logger.warn('skipping taste seed with unparseable content', { userId })
    }
  }
  return seeds
}

/**
 * Batched where-to-watch lookup for the final result set: returns a map of content_id → currently
 * available PlatformOffers in the given region. When platformSlugs is non-empty, offers are limited
 * to those platforms (matching the hard-filter gate); when it is empty, offers across ALL platforms
 * are returned, so every recommendation still carries where-to-watch info by default. Empty map only
 * when there are no content ids.
 */
export async function loadPlatformOffers(
  contentIds: string[],
  platformSlugs: string[],
  region: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  logger: Logger = noopLogger
): Promise<Map<string, PlatformOffer[]>> {
  const result = new Map<string, PlatformOffer[]>()
  if (contentIds.length === 0) return result

  // Resolve platform metadata — restricted to requested slugs, or all platforms when none specified.
  let platformQuery = supabase.from('platforms').select('id, slug, name')
  if (platformSlugs.length > 0) platformQuery = platformQuery.in('slug', platformSlugs)
  const { data: platformRows, error: pErr } = await platformQuery
  if (pErr) {
    throw new EngineError('PLATFORM_LOAD_FAILED', `platform lookup failed: ${pErr.message}`, pErr)
  }
  const platformById = new Map<string, { slug: string; name: string }>()
  for (const p of (platformRows ?? []) as Array<{ id: string; slug: string; name: string }>) {
    platformById.set(p.id, { slug: p.slug, name: p.name })
  }
  if (platformById.size === 0) return result

  const nowIso = new Date().toISOString()
  const { data: offerRows, error: oErr } = await supabase
    .from('content_platforms')
    .select('content_id, platform_id, deep_link, streaming_type')
    .in('content_id', contentIds)
    .in('platform_id', [...platformById.keys()])
    .eq('region', region)
    .or(`available_until.is.null,available_until.gt.${nowIso}`)
  if (oErr) {
    throw new EngineError('PLATFORM_LOAD_FAILED', `availability lookup failed: ${oErr.message}`, oErr)
  }

  for (const row of (offerRows ?? []) as Array<{
    content_id: string
    platform_id: string
    deep_link: string | null
    streaming_type: string | null
  }>) {
    const platform = platformById.get(row.platform_id)
    if (!platform) continue
    const offers = result.get(row.content_id) ?? []
    offers.push({
      slug: platform.slug,
      name: platform.name,
      deepLink: row.deep_link,
      streamingType: row.streaming_type,
    })
    result.set(row.content_id, offers)
  }

  logger.debug('platform offers loaded', { ids: contentIds.length, withOffers: result.size })
  return result
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_RESULT_LIMIT
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(limit)))
}

// Re-exported so an API route can type its handler without reaching into sub-modules.
export type { ScoredCandidate, ResultWithExplanation }
