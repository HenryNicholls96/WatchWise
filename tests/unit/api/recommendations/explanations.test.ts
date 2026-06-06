import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'

const h = vi.hoisted(() => ({
  getRecommendations: vi.fn(),
  emitExplanationMetrics: vi.fn(),
  userId: null as string | null,
}))

// Auth: session-derived user (anonymous by default).
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.userId ? { id: h.userId } : null } }) },
  }),
}))
// No service role → no Supabase cache (also avoids importing 'server-only' under vitest).
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => null }))
// The endpoint re-runs the pipeline via getRecommendations — mock it to observe args + control output.
vi.mock('@/lib/recommendations/engine', () => {
  class EngineError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return { EngineError, getRecommendations: h.getRecommendations }
})
// Spy the emit while keeping the real startTimer/makeJourneyId, so we can assert events on each path.
vi.mock('@/lib/utils/observability', async (orig) => ({
  ...(await orig<typeof import('@/lib/utils/observability')>()),
  emitExplanationMetrics: h.emitExplanationMetrics,
}))

import { POST } from '@/app/api/recommendations/explanations/route'

/** The single explanation_request event the route emitted (last call). */
function lastEvent(): Record<string, unknown> {
  const calls = h.emitExplanationMetrics.mock.calls
  return calls[calls.length - 1][1] as Record<string, unknown>
}

const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'

const METRICS = {
  stages: { retrieveMs: 5, filterMs: 1, scoreMs: 1, explainMs: 40, offersMs: 8 },
  explanation: { cacheHits: 0, cacheMisses: 2, llmUsed: true, fallbackCount: 0, deadlineHit: false, llmError: false, llmRetries: 0, breakerOpen: false },
  funnel: { retrieved: 100, filtered: 42, returned: 2, zeroResult: false, genreExclusionsRelaxed: false },
  blendedCoverage: 1,
}

function rec(id: string, explanation: string) {
  return { content: { id }, explanation }
}

function mockPipeline(recommendations: Array<{ content: { id: string }; explanation: string }>) {
  h.getRecommendations.mockResolvedValue({ recommendations, appliedConstraints: {}, metrics: METRICS })
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/recommendations/explanations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<Response>
}

beforeEach(() => {
  __resetRateLimitStore()
  vi.stubEnv('VOYAGE_API_KEY', 'test-key') // requireEnv passes; client is built but unused (engine mocked)
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  h.userId = null
  h.getRecommendations.mockReset()
  h.emitExplanationMetrics.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/recommendations/explanations', () => {
  it('returns explanations from the server-side pipeline re-run', async () => {
    mockPipeline([rec(ID_1, 'because it is dark and gripping'), rec(ID_2, 'a strong thematic match')])
    const res = await post({ query: 'dark crime drama' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const body = (await res.json()) as { explanations: Record<string, string> }
    expect(body.explanations).toEqual({ [ID_1]: 'because it is dark and gripping', [ID_2]: 'a strong thematic match' })

    // Re-runs with explanations ON, no session write.
    expect(h.getRecommendations).toHaveBeenCalledTimes(1)
    expect(h.getRecommendations.mock.calls[0][0]).toMatchObject({
      queryText: 'dark crime drama',
      withExplanations: true,
      recordSession: false,
    })

    // Emits a success explanation_request event with a correlation id + cache/resilience stats.
    const event = lastEvent()
    expect(event).toMatchObject({ event: 'explanation_request', outcome: 'ok', requested: 2, explained: 2 })
    expect(event.journeyId).toBeTruthy()
    expect(event.explanation).toMatchObject({ llmUsed: true, deadlineHit: false, llmError: false })
  })

  it('ignores forged client ranking data entirely (trust boundary)', async () => {
    mockPipeline([rec(ID_1, 'authoritative explanation')])
    // A malicious client tries to inject scores/confidence/items.
    const res = await post({
      query: 'q',
      scoreBreakdown: { vectorSimilarity: 1, personalization: 1, qualityScore: 1 },
      confidence: 'high',
      items: [{ contentId: ID_1, confidence: 'high' }],
    })

    expect(res.status).toBe(200)
    const arg = h.getRecommendations.mock.calls[0][0]
    // None of the forged ranking fields reach the engine — they're stripped by Zod.
    expect(arg).not.toHaveProperty('scoreBreakdown')
    expect(arg).not.toHaveProperty('confidence')
    expect(arg).not.toHaveProperty('items')
    expect(arg).toMatchObject({ queryText: 'q', withExplanations: true })
  })

  it('omits any result that has no explanation text (partial drop)', async () => {
    mockPipeline([rec(ID_1, 'has one'), { content: { id: ID_2 }, explanation: '' }])
    const res = await post({ query: 'q' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { explanations: Record<string, string> }
    expect(body.explanations[ID_1]).toBe('has one')
    expect(body.explanations[ID_2]).toBeUndefined()
  })

  it('rejects an invalid body with 400 (missing query)', async () => {
    const res = await post({ limit: 8 })
    expect(res.status).toBe(400)
    expect(h.getRecommendations).not.toHaveBeenCalled()
  })

  it('rate-limits anonymous callers after the per-window cap, before any pipeline work', async () => {
    mockPipeline([rec(ID_1, 'x')])
    let last: Response | undefined
    for (let i = 0; i < 21; i++) last = await post({ query: 'q' }) // anon cap is 20/min
    expect(last!.status).toBe(429)
    expect(last!.headers.get('Retry-After')).toBeTruthy()
    // The 21st request was rejected before doing pipeline work.
    expect(h.getRecommendations).toHaveBeenCalledTimes(20)
    // And the rejection still emits a structured event (visible throttling).
    expect(lastEvent()).toMatchObject({ event: 'explanation_request', outcome: 'error', errorCode: 'RATE_LIMITED' })
  })

  it('fails closed with 502 and emits an error event with the pipeline error code', async () => {
    const { EngineError } = await import('@/lib/recommendations/engine')
    h.getRecommendations.mockRejectedValue(new (EngineError as new (c: string, m: string) => Error)('TASTE_LOAD_FAILED', 'boom'))
    const res = await post({ query: 'q' })
    expect(res.status).toBe(502)
    expect(lastEvent()).toMatchObject({ event: 'explanation_request', outcome: 'error', errorCode: 'TASTE_LOAD_FAILED' })
  })
})
