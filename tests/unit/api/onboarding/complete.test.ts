import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable fake of the cookie-aware server Supabase client, controlled per test via h.cfg.
const h = vi.hoisted(() => {
  type Err = { message: string } | null
  const cfg = {
    userId: 'user-1' as string | null,
    seedError: null as Err,
    // One entry per user_profiles update call, in order: [full update, fallback flag-only update].
    profileErrors: [] as Err[],
    captured: {
      seedRows: undefined as unknown,
      seedUpsertCalls: 0,
      profileUpdates: [] as Record<string, unknown>[],
      interactionRows: [] as Record<string, unknown>[],
      affinityRows: [] as Record<string, unknown>[],
    },
  }

  function makeClient() {
    let profileCall = 0
    return {
      auth: {
        getUser: async () => ({ data: { user: cfg.userId ? { id: cfg.userId } : null } }),
      },
      from(table: string) {
        if (table === 'user_taste_seeds') {
          return {
            upsert: async (rows: unknown) => {
              cfg.captured.seedUpsertCalls++
              cfg.captured.seedRows = rows
              return { error: cfg.seedError }
            },
          }
        }
        if (table === 'user_content_interactions') {
          return {
            insert: async (rows: Record<string, unknown>[]) => {
              cfg.captured.interactionRows.push(...rows)
              return { error: null }
            },
          }
        }
        if (table === 'user_category_affinity') {
          return {
            upsert: async (rows: Record<string, unknown>[]) => {
              cfg.captured.affinityRows.push(...rows)
              return { error: null }
            },
          }
        }
        // user_profiles
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              cfg.captured.profileUpdates.push(payload)
              const err = cfg.profileErrors[profileCall] ?? null
              profileCall++
              return { error: err }
            },
          }),
        }
      },
    }
  }

  return { cfg, makeClient }
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.makeClient() }))

// Import after the mock is registered.
import { POST } from '@/app/api/onboarding/complete/route'

// Valid RFC-4122 UUIDs (version nibble 4, variant nibble 8) so they pass Zod's .uuid() check.
const SWIPES = [
  { contentId: '11111111-1111-4111-8111-111111111111', sentiment: 'liked' as const },
  { contentId: '22222222-2222-4222-8222-222222222222', sentiment: 'disliked' as const },
]

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/onboarding/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<Response>
}

beforeEach(() => {
  h.cfg.userId = 'user-1'
  h.cfg.seedError = null
  h.cfg.profileErrors = []
  h.cfg.captured = { seedRows: undefined, seedUpsertCalls: 0, profileUpdates: [], interactionRows: [], affinityRows: [] }
})

describe('POST /api/onboarding/complete', () => {
  it('upserts taste seeds and sets onboarding_completed', async () => {
    const res = await post({ swipes: SWIPES, platforms: ['netflix'], preferences: { mediaType: 'movie' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, seeds: 2 })

    const rows = h.cfg.captured.seedRows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ user_id: 'user-1', content_id: SWIPES[0].contentId, sentiment: 'liked' })
    expect(rows[1]).toMatchObject({ sentiment: 'disliked' }) // dislikes preserved as negative signals

    expect(h.cfg.captured.profileUpdates).toHaveLength(1)
    expect(h.cfg.captured.profileUpdates[0]).toMatchObject({
      preferred_platforms: ['netflix'],
      preferences: { mediaType: 'movie' },
      onboarding_completed: true,
    })
  })

  it('folds "Most Favourite Items" genre picks into category affinities (even with no swipes)', async () => {
    const res = await post({
      swipes: [],
      platforms: [],
      preferences: { favouriteGenres: ['Crime', 'Science Fiction'] },
    })
    expect(res.status).toBe(200)

    // Crime → crime_thriller, Science Fiction → sci_fi_fantasy (registry mapping), each lifted above neutral.
    const byCat = Object.fromEntries(h.cfg.captured.affinityRows.map((r) => [r.category, r]))
    expect(byCat.crime_thriller).toMatchObject({ user_id: 'user-1' })
    expect(byCat.sci_fi_fantasy).toMatchObject({ user_id: 'user-1' })
    expect(byCat.crime_thriller.affinity as number).toBeGreaterThan(0.5)
    // Favourites are not per-title swipes, so nothing lands in the interaction log.
    expect(h.cfg.captured.interactionRows).toHaveLength(0)
  })

  it('completes with zero swipes (no seed write) and still records the flag', async () => {
    const res = await post({ swipes: [], platforms: [], preferences: {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, seeds: 0 })
    expect(h.cfg.captured.seedUpsertCalls).toBe(0)
    expect(h.cfg.captured.profileUpdates[0]).toMatchObject({ onboarding_completed: true })
  })

  it('is fail-open: a profile-update error still returns success and falls back to a flag-only write', async () => {
    h.cfg.profileErrors = [{ message: 'preferences column missing' }, null] // full fails, fallback ok
    const res = await post({ swipes: SWIPES, platforms: ['netflix'], preferences: { runtime: 'hour' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, seeds: 2 })
    // Seeds persisted before the profile write, so they survive the profile failure.
    expect((h.cfg.captured.seedRows as unknown[]).length).toBe(2)
    // Two profile updates: the full one (failed) then the flag-only fallback.
    expect(h.cfg.captured.profileUpdates).toHaveLength(2)
    expect(h.cfg.captured.profileUpdates[1]).toEqual(
      expect.objectContaining({ onboarding_completed: true })
    )
    expect(h.cfg.captured.profileUpdates[1]).not.toHaveProperty('preferred_platforms')
  })

  it('returns 401 when there is no session', async () => {
    h.cfg.userId = null
    const res = await post({ swipes: SWIPES, platforms: [], preferences: {} })
    expect(res.status).toBe(401)
    expect(h.cfg.captured.seedUpsertCalls).toBe(0)
    expect(h.cfg.captured.profileUpdates).toHaveLength(0)
  })

  it('returns 502 when the seed upsert fails, without touching the profile', async () => {
    h.cfg.seedError = { message: 'insert denied' }
    const res = await post({ swipes: SWIPES, platforms: [], preferences: {} })
    expect(res.status).toBe(502)
    expect(h.cfg.captured.profileUpdates).toHaveLength(0)
  })

  it('rejects an invalid body with 400', async () => {
    const res = await post({ swipes: [{ contentId: 'not-a-uuid', sentiment: 'liked' }] })
    expect(res.status).toBe(400)
  })
})
