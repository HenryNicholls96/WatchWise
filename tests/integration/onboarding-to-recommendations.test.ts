// Authenticated end-to-end smoke test — the happy path the rest of the integration suite deliberately
// skips (it uses anonymous requests). Drives the REAL route handlers for a signed-in user:
//
//   POST /api/onboarding/complete  (swipes + follow-up preferences)  →  writes user_taste_seeds + profile
//   POST /api/recommendations      (authenticated)                   →  reads them back and uses them
//
// The only fake is the Supabase boundary, but here it's STATEFUL: a single in-memory DB shared across both
// requests, so what onboarding writes is what the recommendation engine reads. That's the point — it proves
// the onboarding→engine wiring (taste seeds drive personalization; preferences drive filters), not just that
// each endpoint works in isolation. Other boundaries (Voyage/Anthropic SDKs, admin client) are faked as
// elsewhere in the suite. Fast and deterministic — no network, no live Supabase.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeBreaker, voyageBreaker } from '@/lib/utils/circuit-breaker'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'
import { __resetFlagCacheForTests } from '@/lib/flags'
import { __resetTasteProfileCacheForTests } from '@/lib/recommendations/taste-profile'
import { __resetReporterForTests } from '@/lib/utils/error-reporting'

const USER_ID = '99999999-9999-4999-8999-999999999999'
const CRIME_1 = '11111111-1111-4111-8111-111111111111' // liked seed + candidate
const CRIME_2 = '22222222-2222-4222-8222-222222222222' // candidate
const CRIME_3 = '33333333-3333-4333-8333-333333333333' // candidate
const COMEDY = '44444444-4444-4444-8444-444444444444' // disliked seed, NOT a candidate (different genre)

let seq = 0
function contentRow(id: string, genres: string[], type: 'movie' | 'series' = 'series', similarity = 0.7) {
  return {
    id,
    tmdb_id: ++seq,
    title: `Title ${id.slice(0, 4)}`,
    type,
    release_year: 2020,
    description: 'A gripping drama.',
    genres,
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
    similarity,
  }
}

// ─── shared in-memory DB + stateful fake Supabase ─────────────────────────────

type Row = Record<string, unknown>
const db = vi.hoisted(() => ({
  user: null as { id: string } | null,
  tasteSeeds: new Map<string, Row>(), // keyed by content_id (single user)
  profiles: new Map<string, Row>(), // keyed by id
  content: new Map<string, Row>(),
  platforms: [] as Row[],
  contentPlatforms: [] as Row[],
  candidates: [] as Row[],
  sessions: [] as Row[],
}))

function baseRows(table: string): Row[] {
  switch (table) {
    case 'user_taste_seeds':
      return [...db.tasteSeeds.values()]
    case 'user_profiles':
      return [...db.profiles.values()]
    case 'platforms':
      return db.platforms
    case 'content_platforms':
      return db.contentPlatforms
    default:
      return []
  }
}

type Filter = ['eq' | 'in', string, unknown]
function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) =>
    filters.every(([op, col, val]) => (op === 'eq' ? r[col] === val : Array.isArray(val) && val.includes(r[col])))
  )
}

function fakeSupabase() {
  function from(table: string) {
    const state = { table, filters: [] as Filter[], select: '', write: null as null | { fields: Row } }
    const runSelect = () => {
      let rows = applyFilters(baseRows(table), state.filters)
      if (table === 'user_taste_seeds' && state.select.includes('content(')) {
        rows = rows.map((s) => ({ sentiment: s.sentiment, content: db.content.get(s.content_id as string) ?? null }))
      }
      return { data: rows, error: null }
    }
    const applyWrite = () => {
      if (table === 'user_profiles' && state.write) {
        const idFilter = state.filters.find((f) => f[1] === 'id')
        const id = idFilter?.[2] as string
        const existing = db.profiles.get(id)
        if (existing) db.profiles.set(id, { ...existing, ...state.write.fields })
      }
      return { error: null }
    }
    const builder = {
      select: (s?: string) => ((state.select = s ?? ''), builder),
      eq: (col: string, val: unknown) => (state.filters.push(['eq', col, val]), builder),
      in: (col: string, val: unknown) => (state.filters.push(['in', col, val]), builder),
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: () => builder,
      update: (fields: Row) => ((state.write = { fields }), builder),
      maybeSingle: async () => ({ data: runSelect().data[0] ?? null, error: null }),
      upsert: async (rows: Row[]) => {
        if (table === 'user_taste_seeds') for (const r of rows) db.tasteSeeds.set(r.content_id as string, r)
        return { error: null }
      },
      insert: async (row: Row) => {
        if (table === 'recommendation_sessions') db.sessions.push(row)
        return { error: null }
      },
      // Awaiting a select / update chain resolves here.
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(state.write ? applyWrite() : runSelect()).then(onF, onR),
    }
    return builder
  }
  return {
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    rpc: async (name: string) => (name === 'match_content' ? { data: db.candidates, error: null } : { data: null, error: null }),
    from,
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => null }))
vi.mock('voyageai', () => ({
  VoyageAIClient: class {
    embed = async () => ({ data: [{ embedding: new Array(512).fill(0.1) }] })
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: async () => ({ content: [{ type: 'text', text: '[]' }] }) }
  },
}))

import { POST as onboardingComplete } from '@/app/api/onboarding/complete/route'
import { POST as recommend } from '@/app/api/recommendations/route'

function post(handler: (req: Request) => unknown, url: string, body: unknown): Promise<Response> {
  return handler(
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  ) as Promise<Response>
}

beforeEach(() => {
  voyageBreaker.reset()
  claudeBreaker.reset()
  __resetRateLimitStore()
  __resetFlagCacheForTests()
  __resetTasteProfileCacheForTests()
  __resetReporterForTests()
  vi.stubEnv('VOYAGE_API_KEY', 'test')
  vi.stubEnv('ANTHROPIC_API_KEY', 'test')

  // Fresh DB: a signed-in user whose profile row exists (created by the handle_new_user trigger on signup),
  // a small Crime/Drama catalog + one Comedy title, all on Netflix.
  db.user = { id: USER_ID }
  db.tasteSeeds = new Map()
  db.profiles = new Map([[USER_ID, { id: USER_ID, preferred_platforms: [], preferences: {}, onboarding_completed: false }]])
  db.content = new Map(
    [
      contentRow(CRIME_1, ['Crime', 'Drama']),
      contentRow(CRIME_2, ['Crime', 'Drama']),
      contentRow(CRIME_3, ['Crime', 'Drama']),
      contentRow(COMEDY, ['Comedy']),
    ].map((r) => [r.id, r])
  )
  db.candidates = [CRIME_1, CRIME_2, CRIME_3].map((id) => db.content.get(id)!)
  db.platforms = [{ id: 'p-netflix', slug: 'netflix', name: 'Netflix' }]
  db.contentPlatforms = [CRIME_1, CRIME_2, CRIME_3].map((id) => ({
    content_id: id,
    platform_id: 'p-netflix',
    region: 'us',
    available_until: null,
    deep_link: `https://netflix.com/${id.slice(0, 4)}`,
    streaming_type: 'subscription',
  }))
  db.sessions = []
})

afterEach(() => vi.unstubAllEnvs())

describe('authenticated onboarding → recommendations smoke test', () => {
  it('persists swipes + preferences, then uses them on the next recommendation request', async () => {
    // 1) Finish onboarding: like one Crime title, dislike a Comedy title, choose series + Netflix.
    const completeRes = await post(onboardingComplete, 'http://localhost/api/onboarding/complete', {
      swipes: [
        { contentId: CRIME_1, sentiment: 'liked' },
        { contentId: COMEDY, sentiment: 'disliked' },
      ],
      platforms: ['netflix'],
      preferences: { mediaType: 'series', avoidGenres: [], favouriteGenres: [] },
    })
    expect(completeRes.status).toBe(200)
    expect(await completeRes.json()).toMatchObject({ ok: true, seeds: 2 })

    // Onboarding actually wrote the data.
    expect(db.tasteSeeds.get(CRIME_1)).toMatchObject({ sentiment: 'liked' })
    expect(db.tasteSeeds.get(COMEDY)).toMatchObject({ sentiment: 'disliked' })
    expect(db.profiles.get(USER_ID)).toMatchObject({
      onboarding_completed: true,
      preferred_platforms: ['netflix'],
      preferences: { mediaType: 'series' },
    })

    // 2) Now ask for recommendations as the same signed-in user.
    const recRes = await post(recommend, 'http://localhost/api/recommendations', { query: 'gripping crime drama' })
    expect(recRes.status).toBe(200)
    const body = await recRes.json()

    // Preferences are applied: the onboarding content-type + platform defaults shaped the constraints.
    expect(body.appliedConstraints.contentType).toBe('series')
    expect(body.appliedConstraints.platforms).toEqual(['netflix'])

    // Results came back, each with where-to-watch attached.
    expect(body.count).toBeGreaterThan(0)
    for (const r of body.recommendations) {
      expect(r.platforms.map((p: { slug: string }) => p.slug)).toContain('netflix')
    }

    // Taste seeds are used: the liked Crime/Drama seed lifts personalization above neutral (0.5) for the
    // Crime/Drama candidates — which would be exactly 0.5 with no seeds loaded. Proves the onboarding-written
    // seeds were read and fed into scoring.
    for (const r of body.recommendations) {
      expect(r.scoreBreakdown.personalization).toBeGreaterThan(0.5)
    }

    // The session was recorded for the authenticated user.
    expect(db.sessions.length).toBe(1)
    expect(db.sessions[0]).toMatchObject({ user_id: USER_ID })
  })

  it('mediaType "documentary" hard-filters results to Documentary titles', async () => {
    // Add a Documentary title alongside the Crime/Drama catalog, all on Netflix and in the candidate pool.
    const DOC = '55555555-5555-4555-8555-555555555555'
    const docRow = contentRow(DOC, ['Documentary', 'History'], 'movie', 0.72)
    db.content.set(DOC, docRow)
    db.candidates = [docRow, ...db.candidates]
    db.contentPlatforms.push({
      content_id: DOC,
      platform_id: 'p-netflix',
      region: 'us',
      available_until: null,
      deep_link: `https://netflix.com/${DOC.slice(0, 4)}`,
      streaming_type: 'subscription',
    })

    const completeRes = await post(onboardingComplete, 'http://localhost/api/onboarding/complete', {
      swipes: [],
      platforms: ['netflix'],
      preferences: { mediaType: 'documentary' },
    })
    expect(completeRes.status).toBe(200)

    const recRes = await post(recommend, 'http://localhost/api/recommendations', { query: 'a gripping documentary' })
    expect(recRes.status).toBe(200)
    const body = await recRes.json()

    // No contentType constraint (docs span movies + series); the Documentary genre is the hard gate.
    expect(body.appliedConstraints.contentType).toBeUndefined()
    expect(body.count).toBeGreaterThan(0)
    for (const r of body.recommendations) {
      expect(r.content.genres).toContain('Documentary')
    }
    // The Crime/Drama candidates (no Documentary genre) were filtered out.
    expect(body.recommendations.map((r: { content: { id: string } }) => r.content.id)).toEqual([DOC])
  })
})
