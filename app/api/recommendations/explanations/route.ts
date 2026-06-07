// POST /api/recommendations/explanations — deferred "why this" generation for the detail modal.
//
// TRUST BOUNDARY: this endpoint accepts ONLY the user's search intent (the same validated query +
// filters the main endpoint takes) — never client-supplied scores, confidence, or ranking data. It
// RE-RUNS the same server-side pipeline (retrieve → filter → score) with explanations ON, so every
// explanation is grounded exclusively in server-authoritative ranking. The grid already rendered from
// the main (deferred) call, so this runs as a background prefetch — its latency is off the critical path.
//
// Reuse: getRecommendations(withExplanations:true) carries the existing 008 cache, the 3s explanation
// deadline, and generateExplanations verbatim. recordSession:false avoids a duplicate session row, since
// this re-run is purely to explain an already-recorded search.

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
import { type ExplanationRequestMetrics, emitExplanationMetrics, getCurrentRelease, makeJourneyId, startTimer } from '@/lib/utils/observability'

// node:crypto + @supabase/ssr cookies require the Node runtime, not Edge.
export const runtime = 'nodejs'

// Separate rate-limit namespace from the main endpoint (see below). Same per-window caps.
const RATE_WINDOW_MS = 60_000
const ANON_LIMIT = 20
const AUTH_LIMIT = 60

// The SAME validated intent shape as /api/recommendations — and nothing more. There are intentionally
// no score/confidence/ranking fields: explanations must not be influenced by the client. (Unknown keys,
// including a forged scoreBreakdown, are stripped by Zod and never reach the engine.)
const requestSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(1_000),
  platformSlugs: z.array(z.string().min(1)).max(10).optional(),
  region: z.string().min(1).max(10).optional(),
  contentType: z.enum(CONTENT_TYPES).optional(),
  maxRuntimeMinutes: z.number().int().positive().max(1_000).optional(),
  // Must mirror /api/recommendations so the re-run produces the SAME result set the grid showed.
  allowGenres: z.array(z.string().min(1).max(40)).max(20).optional(),
  excludeSeen: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
})

export async function POST(req: Request): Promise<NextResponse> {
  const logger = consoleLogger
  const requestId = randomUUID()
  const stopTimer = startTimer()
  // Correlation id shared with the originating recommendation_request; '' until the query is known.
  let journeyId = ''

  // Emit exactly one structured event per request, on every terminal path.
  const emit = (m: Omit<ExplanationRequestMetrics, 'event' | 'requestId' | 'totalMs'>): void =>
    emitExplanationMetrics(logger, { event: 'explanation_request', requestId, totalMs: stopTimer(), ...m, release: getCurrentRelease() })

  try {
    const supabase = await createClient()

    // Verified identity from the session — never from the body. Anonymous → undefined.
    let userId: string | undefined
    try {
      const { data } = await supabase.auth.getUser()
      userId = data.user?.id
    } catch {
      userId = undefined
    }

    // Rate limit on a SEPARATE namespace from /api/recommendations: this is a 1:1 background prefetch,
    // so it shouldn't consume the user's search budget — but it still fans out to Voyage + Claude, so
    // it's independently bounded (and the 008 cache blunts repeats).
    const ip = clientIpFromHeaders((name) => req.headers.get(name))
    const rlKey = userId ? `expl:user:${userId}` : `expl:ip:${ip}`
    const rl = await checkRateLimit(rlKey, userId ? AUTH_LIMIT : ANON_LIMIT, RATE_WINDOW_MS)
    if (!rl.allowed) {
      emit({ journeyId, outcome: 'error', errorCode: 'RATE_LIMITED', requested: 0, explained: 0 })
      return NextResponse.json(
        { error: 'Too many requests. Please slow down and try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds), 'x-request-id': requestId } }
      )
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      emit({ journeyId, outcome: 'error', errorCode: 'BAD_REQUEST', requested: 0, explained: 0 })
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const parsed = requestSchema.safeParse(rawBody)
    if (!parsed.success) {
      emit({ journeyId, outcome: 'error', errorCode: 'BAD_REQUEST', requested: 0, explained: 0 })
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const { query, ...options } = parsed.data
    journeyId = makeJourneyId(userId ?? `ip:${ip}`, hashQuery(query))

    // Build the same clients the main route uses.
    const voyage = new VoyageAIClient({ apiKey: requireEnv('VOYAGE_API_KEY') })
    const embeddingClient = createVoyageEmbeddingClient(voyage, logger)

    // Resolve flags once for this caller (cheap, cached) — used both to gate the LLM and to stamp the event.
    // explanations_llm off → skip the paid Claude call and let the engine serve deterministic fallbacks
    // (graceful degrade, no user-facing failure). Keyed on the same subject as journeyId.
    const flags = await evaluateAllFlags(userId ?? `ip:${ip}`, { logger })

    let explanationClient: ExplanationClient | undefined
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (anthropicKey && flags.explanations_llm) {
      explanationClient = createClaudeExplanationClient(new Anthropic({ apiKey: anthropicKey }), logger)
    } else if (anthropicKey) {
      logger.info('explanations_llm flag off — serving deterministic fallback explanations')
    }

    let explanationCache: ExplanationCache | undefined
    const serviceClient = createServiceRoleClient()
    if (serviceClient) explanationCache = createSupabaseExplanationCache(serviceClient, { logger })

    // Resolve the SAME score weights the grid used (from the same flags), so the re-ranked result set is
    // identical and explanations map back cleanly by content id.
    const scoreWeights = buildScoreWeights(flags.category_affinity ? getCategoryAffinityWeight() : 0)

    // Re-run the SAME pipeline, explanations ON, no session write. Scoring is server-authoritative; the
    // client supplied no ranking data. Deterministic for a given (query, taste, catalog), so the result
    // set aligns with the grid the main call returned; the client maps explanations back by content id.
    const { recommendations, metrics } = await getRecommendations(
      { queryText: query, userId, withExplanations: true, recordSession: false, stampAlreadySeen: false, scoreWeights, ...options },
      { supabase, embeddingClient, explanationClient, explanationCache, logger }
    )

    const explanations: Record<string, string> = {}
    for (const r of recommendations) if (r.explanation) explanations[r.content.id] = r.explanation

    emit({
      journeyId,
      outcome: 'ok',
      requested: recommendations.length,
      explained: Object.keys(explanations).length,
      explanation: metrics.explanation,
      flags,
    })

    return NextResponse.json({ explanations }, { headers: { 'x-request-id': requestId } })
  } catch (err) {
    // Fail-open from the user's view: the grid already rendered, so a failure here just leaves the modal
    // to show its own fallback line. We surface 502 and record the failure for observability.
    const errorCode = errorCodeOf(err)
    emit({ journeyId, outcome: 'error', errorCode, requested: 0, explained: 0 })
    if (errorCode !== 'INVALID_INPUT') {
      captureException(err, { route: 'POST /api/recommendations/explanations', requestId, journeyId, errorCode })
      // Serverless freezes the instance after the response; flush so the event isn't lost.
      await flushErrorReporting()
    }
    logger.error('explanation request failed', { message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: 'Could not load explanations right now.' },
      { status: 502, headers: { 'x-request-id': requestId } }
    )
  }
}

/** Stable error code for the metrics event from our typed pipeline errors. */
function errorCodeOf(err: unknown): string {
  if (err instanceof EngineError || err instanceof RetrievalError || err instanceof FilterError) return err.code
  return 'UNKNOWN'
}
