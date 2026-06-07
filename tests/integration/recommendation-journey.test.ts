// Integration coverage for the full recommendation → deferred explanation journey, exercising the REAL
// route handlers + engine + retrieval + filters + scoring + explanations + circuit breakers. Only the
// external boundaries are faked: the Voyage + Anthropic SDKs, Supabase, and the observability emitters
// (spied so we can assert the structured events). Anonymous requests with no platform filter keep the
// fake DB minimal (auth + match_content RPC + an empty platforms select + the session insert).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeBreaker, voyageBreaker } from '@/lib/utils/circuit-breaker'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'
import { __resetFlagCacheForTests } from '@/lib/flags'
import { __resetReleaseCacheForTests } from '@/lib/utils/observability'
import { __resetReporterForTests, __setReporterForTests } from '@/lib/utils/error-reporting'

const TEST_SHA = '1234567890abcdef1234567890abcdef12345678' // 40-hex → short release '1234567'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const C3 = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  emitRec: vi.fn(),
  emitExpl: vi.fn(),
  emitBreaker: vi.fn(),
  voyageEmbed: vi.fn(),
  claudeCreate: vi.fn(),
  user: null as { id: string } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  candidates: [] as any[],
}))

// Spy the emitters; keep the real startTimer / makeJourneyId (so journeyId correlation is genuine) and
// the real emitCircuitBreakerEvent target is replaced by our spy (the breaker calls it on transitions).
vi.mock('@/lib/utils/observability', async (orig) => ({
  ...(await orig<typeof import('@/lib/utils/observability')>()),
  emitRecommendationMetrics: h.emitRec,
  emitExplanationMetrics: h.emitExpl,
  emitCircuitBreakerEvent: h.emitBreaker,
}))
vi.mock('voyageai', () => ({
  VoyageAIClient: class {
    embed = (...args: unknown[]) => h.voyageEmbed(...args)
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => h.claudeCreate(...args) }
  },
}))
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => null }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))

import { POST as mainPOST } from '@/app/api/recommendations/route'
import { POST as explPOST } from '@/app/api/recommendations/explanations/route'

// ─── fakes ──────────────────────────────────────────────────────────────────

let tmdbSeq = 0
function candidateRow(id: string) {
  return {
    id,
    tmdb_id: ++tmdbSeq,
    title: `Title ${id.slice(0, 4)}`,
    type: 'series',
    release_year: 2020,
    description: 'A dark, gripping crime drama.',
    genres: ['Crime', 'Drama'],
    mood_tags: ['dark'],
    theme_tags: [],
    cast_names: [],
    director_names: [],
    runtime_minutes: null,
    avg_episode_minutes: 50,
    season_count: 2,
    imdb_rating: null,
    tmdb_rating: 8.0,
    tmdb_vote_count: 1500,
    poster_url: null,
    backdrop_url: null,
    original_language: 'en',
    content_rating: null,
    blended_rating: 85,
    rating_sources: null,
    similarity: 0.7,
  }
}

function fakeSupabase() {
  function makeChain() {
    const res = { data: [] as unknown[], error: null }
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      gt: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      then: (onF: (v: typeof res) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(res).then(onF, onR),
    }
    return chain
  }
  return {
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    rpc: async (name: string) => (name === 'match_content' ? { data: h.candidates, error: null } : { data: null, error: null }),
    from: () => makeChain(),
  }
}

function claudeSucceeds() {
  h.claudeCreate.mockImplementation(async () => ({
    content: [{ type: 'text', text: JSON.stringify([C1, C2, C3].map((id) => ({ content_id: id, explanation: `why ${id}` }))) }],
  }))
}
function claudeHangs() {
  h.claudeCreate.mockImplementation(() => new Promise<never>(() => {}))
}

function mainReq(body: unknown): Promise<Response> {
  return mainPOST(
    new Request('http://localhost/api/recommendations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  ) as unknown as Promise<Response>
}
function explReq(body: unknown): Promise<Response> {
  return explPOST(
    new Request('http://localhost/api/recommendations/explanations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  ) as unknown as Promise<Response>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastRec = (): any => h.emitRec.mock.calls.at(-1)?.[1]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastExpl = (): any => h.emitExpl.mock.calls.at(-1)?.[1]
const breakerStates = (): string[] => h.emitBreaker.mock.calls.map((c) => (c[1] as { state: string }).state)

// ─── lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  claudeBreaker.reset()
  voyageBreaker.reset()
  __resetRateLimitStore()
  __resetFlagCacheForTests()
  __resetReleaseCacheForTests()
  __resetReporterForTests()
  vi.stubEnv('VOYAGE_API_KEY', 'test')
  vi.stubEnv('ANTHROPIC_API_KEY', 'test')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', TEST_SHA)
  h.emitRec.mockReset()
  h.emitExpl.mockReset()
  h.emitBreaker.mockReset()
  h.voyageEmbed.mockReset()
  h.claudeCreate.mockReset()
  h.user = null
  h.candidates = [candidateRow(C1), candidateRow(C2), candidateRow(C3)]
  h.voyageEmbed.mockResolvedValue({ data: [{ embedding: new Array(512).fill(0.1) }] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// ─── tests ──────────────────────────────────────────────────────────────────

describe('recommendation → deferred explanation journey', () => {
  it('happy path: main + explanation share a journeyId; main is deferred, explanation uses the LLM', async () => {
    claudeSucceeds()
    const query = 'dark crime drama'

    const mainRes = await mainReq({ query })
    expect(mainRes.status).toBe(200)
    const rec = lastRec()
    expect(rec).toMatchObject({ event: 'recommendation_request', outcome: 'ok' })
    expect(rec.journeyId).toBeTruthy()
    expect(rec.pipeline.stages.explainMs).toBe(0) // explanations deferred
    expect(rec.pipeline.explanation).toMatchObject({ llmUsed: false, breakerOpen: false })
    expect(rec.flags).toMatchObject({ explanations_llm: true }) // active flags stamped on the event
    expect(rec.release).toBe('1234567') // deploy/release stamped on the event

    const explRes = await explReq({ query })
    expect(explRes.status).toBe(200)
    const expl = lastExpl()
    expect(expl).toMatchObject({ event: 'explanation_request', outcome: 'ok' })
    expect(expl.explanation).toMatchObject({ llmUsed: true, deadlineHit: false, llmError: false, breakerOpen: false })
    expect(expl.flags).toMatchObject({ explanations_llm: true })
    expect(expl.release).toBe('1234567')

    // Same caller + same query → the two events correlate.
    expect(expl.journeyId).toBe(rec.journeyId)
  })

  it('allowGenres relaxes a query-driven soft genre exclusion (the removable filter chip)', async () => {
    // "without horror" → the engine applies a soft Horror exclusion, surfaced as an Applied-filters chip.
    const excluded = await mainReq({ query: 'dark crime drama without horror' })
    expect(excluded.status).toBe(200)
    expect((await excluded.json()).appliedConstraints.excludeGenres).toEqual(['Horror'])

    // Clicking the chip re-runs with allowGenres:['Horror'] → the exclusion is dropped (broadens results).
    const relaxed = await mainReq({ query: 'dark crime drama without horror', allowGenres: ['Horror'] })
    expect(relaxed.status).toBe(200)
    expect((await relaxed.json()).appliedConstraints.excludeGenres).toEqual([])
  })

  it('explanations_llm flag off → explanation route skips the LLM and serves deterministic fallbacks', async () => {
    vi.stubEnv('FLAG_EXPLANATIONS_LLM', 'off') // emergency kill switch
    claudeSucceeds() // would be used if the flag were on

    const explRes = await explReq({ query: 'dark crime drama' })
    expect(explRes.status).toBe(200)

    expect(h.claudeCreate).not.toHaveBeenCalled() // paid LLM call skipped by the flag
    const expl = lastExpl()
    expect(expl).toMatchObject({ event: 'explanation_request', outcome: 'ok' })
    expect(expl.explanation).toMatchObject({ llmUsed: false }) // deterministic fallbacks
    expect(expl.flags).toMatchObject({ explanations_llm: false }) // kill switch reflected on the event
    const body = await explRes.json()
    expect(Object.keys(body.explanations).length).toBeGreaterThan(0) // explanations still returned
  })

  it('error paths emit with the right code and an empty journeyId (bad input)', async () => {
    expect((await mainReq({ notquery: 1 })).status).toBe(400)
    expect(lastRec()).toMatchObject({ outcome: 'error', errorCode: 'BAD_REQUEST', journeyId: '' })
    expect(lastRec().release).toBe('1234567') // release stamped even on error paths

    expect((await explReq({ notquery: 1 })).status).toBe(400)
    expect(lastExpl()).toMatchObject({ outcome: 'error', errorCode: 'BAD_REQUEST', journeyId: '' })
  })

  it('rate limit emits RATE_LIMITED once the per-window cap is exceeded', async () => {
    let last: Response | undefined
    for (let i = 0; i < 21; i++) last = await mainReq({ query: 'q' }) // anon cap = 20
    expect(last!.status).toBe(429)
    expect(lastRec()).toMatchObject({ outcome: 'error', errorCode: 'RATE_LIMITED' })
  })

  it('voyage breaker open → main request fails fast (EMBEDDING_FAILED) without calling Voyage', async () => {
    for (let i = 0; i < 4; i++) await voyageBreaker.recordFailure() // default threshold 4 → open (opening is unit-tested)
    h.voyageEmbed.mockClear()
    const reporter = { captureException: vi.fn(), captureMessage: vi.fn() }
    __setReporterForTests(reporter) // prove the route catch reports unexpected/upstream failures

    const res = await mainReq({ query: 'q' })
    expect(res.status).toBe(502)
    expect(h.voyageEmbed).not.toHaveBeenCalled() // rejected before any upstream call
    expect(lastRec()).toMatchObject({ outcome: 'error', errorCode: 'EMBEDDING_FAILED' })
    expect(reporter.captureException).toHaveBeenCalledTimes(1)
    expect(reporter.captureException.mock.calls[0][1]).toMatchObject({
      tags: { route: 'POST /api/recommendations', errorCode: 'EMBEDDING_FAILED' },
    })
  })

  it('claude breaker: repeated deadlines open it (skip → fast degrade), then it recovers after cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    // 1) Three deadline-tripping explanation requests (default threshold 3) → breaker opens.
    claudeHangs()
    for (let i = 0; i < 3; i++) {
      const p = explReq({ query: `q${i}` })
      await vi.advanceTimersByTimeAsync(3_000) // trip the 3s LLM deadline
      const res = await p
      expect(res.status).toBe(200) // fail-open: still returns (deterministic fallbacks)
      expect(lastExpl().explanation).toMatchObject({ deadlineHit: true, breakerOpen: false })
    }
    expect(breakerStates()).toContain('open')
    expect((await claudeBreaker.snapshot()).state).toBe('open')

    // 2) Next request while open → LLM skipped, fast degrade, no deadline incurred.
    const openRes = await explReq({ query: 'q-open' })
    expect(openRes.status).toBe(200)
    expect(lastExpl().explanation).toMatchObject({ breakerOpen: true, llmUsed: false, deadlineHit: false })

    // 3) Recovery: advance past the cooldown (default 30s) → half-open trial → success → closed.
    claudeSucceeds()
    await vi.advanceTimersByTimeAsync(31_000)
    const recP = explReq({ query: 'q-recover' })
    await vi.advanceTimersByTimeAsync(1) // flush the (immediately-resolving) LLM call
    const recRes = await recP
    expect(recRes.status).toBe(200)
    expect(lastExpl().explanation).toMatchObject({ llmUsed: true, breakerOpen: false })

    expect(breakerStates()).toContain('half-open')
    expect((await claudeBreaker.snapshot()).state).toBe('closed')
  })
})
