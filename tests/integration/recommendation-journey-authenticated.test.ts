// Integration coverage for the AUTHENTICATED recommendation journey — the DB paths the anonymous suite
// (recommendation-journey.test.ts) deliberately skips. A signed-in user exercises every server-side
// data dependency at once: taste seeds (user_taste_seeds → personalization), onboarding defaults
// (user_profiles → loadUserDefaults), platform-availability filtering (content_platforms), where-to-watch
// (loadPlatformOffers), and best-effort session persistence (recommendation_sessions).
//
// Only the external boundaries are faked — the Voyage + Anthropic SDKs, Supabase, and the observability
// emitters (spied to assert the structured events). Unlike the anonymous suite's table-agnostic fake, the
// Supabase fake here is table-aware: each table returns its own fixture so the authenticated paths run for
// real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeBreaker, voyageBreaker } from '@/lib/utils/circuit-breaker'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'

const USER_ID = '44444444-4444-4444-8444-444444444444'
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasteSeeds: [] as any[],
  profile: null as { preferred_platforms?: unknown; preferences?: unknown } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  platformRows: [] as any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  availability: [] as any[],
  inserts: [] as string[],
}))

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

// Table-aware fake: every chain terminal (`then` for selects, `maybeSingle`, `insert`) returns the
// fixture for the table the chain was opened on, so the authenticated data-loading paths run for real.
function fakeSupabase() {
  function makeChain(table: string) {
    const data = (): unknown[] => {
      switch (table) {
        case 'user_taste_seeds':
          return h.tasteSeeds
        case 'platforms':
          return h.platformRows
        case 'content_platforms':
          return h.availability
        default:
          return []
      }
    }
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      gt: () => chain,
      maybeSingle: async () => ({ data: table === 'user_profiles' ? h.profile : null, error: null }),
      insert: async () => {
        h.inserts.push(table)
        return { error: null }
      },
      upsert: async () => ({ error: null }),
      then: (onF: (v: { data: unknown[]; error: null }) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: data(), error: null }).then(onF, onR),
    }
    return chain
  }
  return {
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    rpc: async (name: string) => (name === 'match_content' ? { data: h.candidates, error: null } : { data: null, error: null }),
    from: (table: string) => makeChain(table),
  }
}

function claudeSucceeds() {
  h.claudeCreate.mockImplementation(async () => ({
    content: [{ type: 'text', text: JSON.stringify([C1, C2, C3].map((id) => ({ content_id: id, explanation: `why ${id}` }))) }],
  }))
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

// ─── lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  claudeBreaker.reset()
  voyageBreaker.reset()
  __resetRateLimitStore()
  vi.stubEnv('VOYAGE_API_KEY', 'test')
  vi.stubEnv('ANTHROPIC_API_KEY', 'test')
  h.emitRec.mockReset()
  h.emitExpl.mockReset()
  h.emitBreaker.mockReset()
  h.voyageEmbed.mockReset()
  h.claudeCreate.mockReset()
  h.inserts = []

  // A signed-in user with one liked seed, a Netflix-only onboarding profile, and a catalog of three
  // series — two available on Netflix (C1, C2), one not (C3, which the platform gate must drop).
  h.user = { id: USER_ID }
  h.candidates = [candidateRow(C1), candidateRow(C2), candidateRow(C3)]
  h.tasteSeeds = [{ sentiment: 'liked', content: candidateRow(C1) }]
  h.profile = { preferred_platforms: ['netflix'], preferences: { contentType: 'series', avoidGenres: [], runtime: 'any' } }
  h.platformRows = [{ id: 'p-netflix', slug: 'netflix', name: 'Netflix' }]
  h.availability = [C1, C2].map((id) => ({
    content_id: id,
    platform_id: 'p-netflix',
    available_until: null,
    deep_link: `https://netflix.com/${id.slice(0, 4)}`,
    streaming_type: 'subscription',
  }))

  h.voyageEmbed.mockResolvedValue({ data: [{ embedding: new Array(512).fill(0.1) }] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// ─── tests ──────────────────────────────────────────────────────────────────

describe('authenticated recommendation journey', () => {
  it('loads taste seeds + onboarding defaults, gates on platform availability, attaches offers, and records the session', async () => {
    const res = await mainReq({ query: 'dark crime drama' })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Onboarding profile supplied the platform allow-set + content type (no per-request override).
    expect(body.appliedConstraints.platforms).toEqual(['netflix'])
    expect(body.appliedConstraints.contentType).toBe('series')

    // C3 has no Netflix availability row → the platform gate drops it; C1 + C2 survive.
    expect(body.count).toBe(2)
    const ids = body.recommendations.map((r: { content: { id: string } }) => r.content.id)
    expect(ids).toEqual(expect.arrayContaining([C1, C2]))
    expect(ids).not.toContain(C3)

    // Where-to-watch is attached from content_platforms (loadPlatformOffers).
    for (const r of body.recommendations) {
      expect(r.platforms).toHaveLength(1)
      expect(r.platforms[0]).toMatchObject({ slug: 'netflix', name: 'Netflix' })
      expect(r.platforms[0].deepLink).toMatch(/^https:\/\/netflix\.com\//)
    }

    // The liked seed overlaps the candidates' tags → personalization is lifted above neutral (0.5),
    // proving taste seeds were loaded and fed into scoring (anonymous would score a flat 0.5).
    for (const r of body.recommendations) {
      expect(r.scoreBreakdown.personalization).toBeGreaterThan(0.5)
    }

    // Funnel reflects the platform drop, and the session was persisted (best-effort write fired).
    const rec = lastRec()
    expect(rec).toMatchObject({ event: 'recommendation_request', outcome: 'ok' })
    expect(rec.pipeline.funnel).toMatchObject({ retrieved: 3, filtered: 2, returned: 2, zeroResult: false })
    expect(h.inserts).toContain('recommendation_sessions')
  })

  it('explanation re-run explains only the platform-eligible results and does NOT persist a second session', async () => {
    claudeSucceeds()

    const res = await explReq({ query: 'dark crime drama' })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Server-authoritative re-run yields the same 2 eligible ids; C3 (no offer) is never explained.
    expect(Object.keys(body.explanations).sort()).toEqual([C1, C2].sort())
    expect(body.explanations[C3]).toBeUndefined()

    const expl = lastExpl()
    expect(expl).toMatchObject({ event: 'explanation_request', outcome: 'ok', requested: 2, explained: 2 })
    expect(expl.explanation).toMatchObject({ llmUsed: true })

    // recordSession:false on the deferred re-run → no duplicate session row for an already-recorded search.
    expect(h.inserts).not.toContain('recommendation_sessions')
  })

  it('an explicit per-request constraint overrides the onboarding default (precedence)', async () => {
    // Profile defaults to series, but this request explicitly asks for movies — explicit param wins.
    const res = await mainReq({ query: 'dark crime drama', contentType: 'movie' })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.appliedConstraints.contentType).toBe('movie')
    // All candidates are series → the content-type gate empties the set before the platform query.
    expect(body.count).toBe(0)
    expect(lastRec().pipeline.funnel).toMatchObject({ filtered: 0, returned: 0, zeroResult: true })
  })
})
