// POST /api/recommendations — the public entry point to the recommendation pipeline.
//
// Validates the request (Zod), constructs the real Voyage + Claude clients, and delegates to
// engine.getRecommendations. Claude is optional: with no ANTHROPIC_API_KEY the engine degrades to
// deterministic fallback explanations, so the slice still returns cards. Persistence of sessions /
// results is intentionally deferred (see route-level TODO).

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { VoyageAIClient } from 'voyageai'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { requireEnv } from '@/lib/utils/env'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { clientIpFromHeaders } from '@/lib/utils/client-ip'
import { consoleLogger } from '@/lib/types/logger'
import { CONTENT_TYPES } from '@/lib/types/content'
import { createVoyageEmbeddingClient, RetrievalError } from '@/lib/recommendations/retrieval'
import { FilterError } from '@/lib/recommendations/filters'
import {
  type ExplanationCache,
  type ExplanationClient,
  createClaudeExplanationClient,
  hashQuery,
} from '@/lib/recommendations/explanations'
import { createSupabaseExplanationCache } from '@/lib/recommendations/explanation-cache'
import { EngineError, getRecommendations } from '@/lib/recommendations/engine'
import { evaluateAllFlags } from '@/lib/flags'
import { buildScoreWeights, getCategoryAffinityWeight } from '@/lib/recommendations/scoring'
import { captureException, flushErrorReporting } from '@/lib/utils/error-reporting'
import { type RecommendationMetrics, emitRecommendationMetrics, getCurrentRelease, makeJourneyId, startTimer } from '@/lib/utils/observability'

// node:crypto (hashQuery) + @supabase/ssr cookies require the Node runtime, not Edge.
export const runtime = 'nodejs'

// Rate limits: per authenticated user, or per client IP for anonymous requests. Each allowed request
// fans out to paid Voyage + Claude calls, so the window is deliberately tight.
const RATE_WINDOW_MS = 60_000
const ANON_LIMIT = 20
const AUTH_LIMIT = 60

// Note: `userId` is intentionally NOT accepted from the client — identity is derived server-side from
// the Supabase session (see below). Unknown keys (including a stray userId) are stripped by Zod.
const requestSchema = z
  .object({
    // Optional so 'for-you' (no-query) requests validate; required for 'search' (enforced below).
    query: z.string().trim().min(1, 'query is required').max(1_000).optional(),
    /** 'search' (default) embeds the query; 'for-you' embeds a taste-derived query (no user text). */
    recommendationMode: z.enum(['search', 'for-you']).optional(),
    platformSlugs: z.array(z.string().min(1)).max(10).optional(),
    region: z.string().min(1).max(10).optional(),
    contentType: z.enum(CONTENT_TYPES).optional(),
    maxRuntimeMinutes: z.number().int().positive().max(1_000).optional(),
    excludeContentIds: z.array(z.string().uuid()).max(200).optional(),
    // Soft genre exclusions the caller wants relaxed (the UI's "un-click this filter" action). Only broadens
    // results — never adds a hard filter — so it's safe to accept from the client.
    allowGenres: z.array(z.string().min(1).max(40)).max(20).optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.recommendationMode ?? 'search') === 'search' && !val.query) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query is required', path: ['query'] })
    }
  })

export async function POST(req: Request): Promise<NextResponse> {
  const logger = consoleLogger
  const requestId = randomUUID()
  const stopTimer = startTimer()
  // Correlation id (caller + query) shared with the deferred explanation_request; '' until the query is known.
  let journeyId = ''

  // Emit exactly one structured event per request, on every terminal path.
  const emit = (m: Omit<RecommendationMetrics, 'event' | 'requestId' | 'totalMs'>): void =>
    emitRecommendationMetrics(logger, { event: 'recommendation_request', requestId, totalMs: stopTimer(), ...m, release: getCurrentRelease() })

  try {
    const supabase = await createClient()

    // 1) Verified identity from the session — never from the request body. Anonymous → null.
    let userId: string | undefined
    try {
      const { data } = await supabase.auth.getUser()
      userId = data.user?.id
    } catch {
      userId = undefined
    }

    // 2) Rate limit (before any paid work). Keyed per user when authed, else per trusted client IP.
    const ip = clientIpFromHeaders((name) => req.headers.get(name))
    const rlKey = userId ? `user:${userId}` : `ip:${ip}`
    const rl = await checkRateLimit(rlKey, userId ? AUTH_LIMIT : ANON_LIMIT, RATE_WINDOW_MS)
    if (!rl.allowed) {
      emit({ journeyId, outcome: 'error', errorCode: 'RATE_LIMITED' })
      return NextResponse.json(
        { error: 'Too many requests. Please slow down and try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds), 'x-request-id': requestId } }
      )
    }

    // 3) Validate body.
    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      emit({ journeyId, outcome: 'error', errorCode: 'BAD_REQUEST' })
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const parsed = requestSchema.safeParse(rawBody)
    if (!parsed.success) {
      emit({ journeyId, outcome: 'error', errorCode: 'BAD_REQUEST' })
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const { query, ...options } = parsed.data
    // For-you requests have no query text; namespace the correlation id so it's stable per caller.
    journeyId = makeJourneyId(userId ?? `ip:${ip}`, hashQuery(query ?? 'for-you'))

    // 4) Build clients and run the pipeline.
    const voyage = new VoyageAIClient({ apiKey: requireEnv('VOYAGE_API_KEY') })
    const embeddingClient = createVoyageEmbeddingClient(voyage, logger)

    // Claude is best-effort. No key → engine uses deterministic fallback explanations.
    let explanationClient: ExplanationClient | undefined
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (anthropicKey) {
      explanationClient = createClaudeExplanationClient(new Anthropic({ apiKey: anthropicKey }), logger)
    } else {
      logger.warn('ANTHROPIC_API_KEY not set — using deterministic fallback explanations')
    }

    // Shared, cross-request explanation cache (service-role, server-only). Absent service key →
    // undefined → generateExplanations falls back to a per-request in-memory cache (fail-open).
    let explanationCache: ExplanationCache | undefined
    const serviceClient = createServiceRoleClient()
    if (serviceClient) explanationCache = createSupabaseExplanationCache(serviceClient, { logger })

    // Resolve flags once (cheap, cached): used to stamp the event AND to gate the category-affinity scoring
    // weight. category_affinity off → weight 0 (server-side; never client-supplied, so it's trust-safe).
    const flags = await evaluateAllFlags(userId ?? `ip:${ip}`, { logger })
    const scoreWeights = buildScoreWeights(flags.category_affinity ? getCategoryAffinityWeight() : 0)

    // Explanations are DEFERRED: the grid doesn't render them (they live only in the detail modal), so
    // we return scored results immediately and the client fetches explanations via /explanations.
    // `recommendationMode` flows through ...options; queryText is '' for the for-you (no-query) path.
    const { recommendations, appliedConstraints, metrics } = await getRecommendations(
      { queryText: query ?? '', userId, withExplanations: false, scoreWeights, ...options },
      { supabase, embeddingClient, explanationClient, explanationCache, logger }
    )

    emit({ journeyId, outcome: 'ok', pipeline: metrics, flags })

    // Note: metrics are logged, never returned to the client.
    return NextResponse.json(
      { count: recommendations.length, recommendations, appliedConstraints },
      { headers: { 'x-request-id': requestId } }
    )
  } catch (err) {
    const errorCode = errorCodeOf(err)
    emit({ journeyId, outcome: 'error', errorCode })
    // Report unexpected/upstream failures (skip plain bad-input, which is a client error, not a bug).
    if (errorCode !== 'INVALID_INPUT') {
      captureException(err, { route: 'POST /api/recommendations', requestId, journeyId, errorCode })
      // Serverless freezes the instance after the response; flush so the event isn't lost.
      await flushErrorReporting()
    }
    return toErrorResponse(err, logger, requestId)
  }
}

/** Maps typed pipeline errors to calm, appropriately-coded HTTP responses. */
function toErrorResponse(err: unknown, logger: typeof consoleLogger, requestId: string): NextResponse {
  const headers = { 'x-request-id': requestId }

  // Bad input that slipped past Zod (e.g. engine-level validation) → 400.
  if (
    (err instanceof EngineError || err instanceof RetrievalError || err instanceof FilterError) &&
    err.code === 'INVALID_INPUT'
  ) {
    return NextResponse.json({ error: err.message }, { status: 400, headers })
  }

  // Upstream/data failures (embedding, vector search, DB lookups) → 502.
  if (err instanceof EngineError || err instanceof RetrievalError || err instanceof FilterError) {
    logger.error('recommendation pipeline failed', { code: err.code, message: err.message })
    return NextResponse.json(
      { error: 'We had trouble finding recommendations just now. Please try again.' },
      { status: 502, headers }
    )
  }

  logger.error('unexpected error in recommendations route', {
    message: err instanceof Error ? err.message : String(err),
  })
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500, headers })
}

/** Extracts a stable error code for the metrics event from our typed pipeline errors. */
function errorCodeOf(err: unknown): string {
  if (err instanceof EngineError || err instanceof RetrievalError || err instanceof FilterError) return err.code
  return 'UNKNOWN'
}
