import { describe, expect, it, vi } from 'vitest'
import { createSupabaseExplanationCache } from '@/lib/recommendations/explanation-cache'

type MaybeSingleResult = { data: unknown; error: { message: string } | null }

// Minimal fake of the supabase query chain the cache uses:
//   from(table).select(cols).eq(col, val).maybeSingle()      ← get
//   from(table).select(cols).in(col, vals)                   ← getMany
//   from(table).upsert(row|rows, opts)                       ← set / setMany
function fakeSupabase(opts: {
  maybeSingle?: () => MaybeSingleResult
  inResult?: () => { data: unknown[] | null; error: { message: string } | null }
  onUpsert?: (row: unknown) => { error: { message: string } | null }
}) {
  const upsert = vi.fn(async (row: unknown) => (opts.onUpsert ? opts.onUpsert(row) : { error: null }))
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (opts.maybeSingle ? opts.maybeSingle() : { data: null, error: null }),
        }),
        in: async () => (opts.inResult ? opts.inResult() : { data: [], error: null }),
      }),
      upsert,
    }),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, upsert }
}

describe('createSupabaseExplanationCache', () => {
  it('returns a fresh cached explanation (within TTL)', async () => {
    const { client } = fakeSupabase({
      maybeSingle: () => ({ data: { explanation: 'because…', created_at: new Date().toISOString() }, error: null }),
    })
    const cache = createSupabaseExplanationCache(client)
    expect(await cache.get('a:b:c')).toBe('because…')
  })

  it('treats stale rows (older than TTL) as a miss', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { client } = fakeSupabase({
      maybeSingle: () => ({ data: { explanation: 'stale', created_at: old }, error: null }),
    })
    const cache = createSupabaseExplanationCache(client, { ttlMs: 24 * 60 * 60 * 1000 })
    expect(await cache.get('k')).toBeUndefined()
  })

  it('returns undefined on a miss', async () => {
    const { client } = fakeSupabase({ maybeSingle: () => ({ data: null, error: null }) })
    expect(await createSupabaseExplanationCache(client).get('k')).toBeUndefined()
  })

  it('fails open (returns undefined) on a read error', async () => {
    const { client } = fakeSupabase({ maybeSingle: () => ({ data: null, error: { message: 'relation does not exist' } }) })
    expect(await createSupabaseExplanationCache(client).get('k')).toBeUndefined()
  })

  it('upserts on set with the cache_key conflict target', async () => {
    const { client, upsert } = fakeSupabase({})
    await createSupabaseExplanationCache(client).set('a:b:c', 'why this')
    expect(upsert).toHaveBeenCalledTimes(1)
    const [row] = upsert.mock.calls[0]
    expect(row).toMatchObject({ cache_key: 'a:b:c', explanation: 'why this' })
  })

  it('fails open (no throw) when set errors', async () => {
    const { client } = fakeSupabase({ onUpsert: () => ({ error: { message: 'denied' } }) })
    await expect(createSupabaseExplanationCache(client).set('k', 'v')).resolves.toBeUndefined()
  })
})

describe('createSupabaseExplanationCache — batched (getMany/setMany)', () => {
  it('getMany returns only the fresh rows, omitting stale ones', async () => {
    const fresh = new Date().toISOString()
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { client } = fakeSupabase({
      inResult: () => ({
        data: [
          { cache_key: 'k1', explanation: 'fresh', created_at: fresh },
          { cache_key: 'k2', explanation: 'old', created_at: stale },
        ],
        error: null,
      }),
    })
    const out = await createSupabaseExplanationCache(client).getMany!(['k1', 'k2'])
    expect(out.get('k1')).toBe('fresh')
    expect(out.has('k2')).toBe(false)
  })

  it('getMany short-circuits with no keys (no query, empty map)', async () => {
    const { client } = fakeSupabase({})
    expect((await createSupabaseExplanationCache(client).getMany!([])).size).toBe(0)
  })

  it('getMany fails open (empty map) on a read error', async () => {
    const { client } = fakeSupabase({ inResult: () => ({ data: null, error: { message: 'no relation' } }) })
    expect((await createSupabaseExplanationCache(client).getMany!(['k'])).size).toBe(0)
  })

  it('setMany upserts every entry in a single call', async () => {
    const { client, upsert } = fakeSupabase({})
    await createSupabaseExplanationCache(client).setMany!([
      { key: 'a:b:c', value: 'x' },
      { key: 'd:e:f', value: 'y' },
    ])
    expect(upsert).toHaveBeenCalledTimes(1)
    const rows = upsert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ cache_key: 'a:b:c', explanation: 'x' })
    expect(rows[1]).toMatchObject({ cache_key: 'd:e:f', explanation: 'y' })
  })

  it('setMany is a no-op (no upsert) for an empty batch', async () => {
    const { client, upsert } = fakeSupabase({})
    await createSupabaseExplanationCache(client).setMany!([])
    expect(upsert).not.toHaveBeenCalled()
  })

  it('setMany fails open (no throw) on a write error', async () => {
    const { client } = fakeSupabase({ onUpsert: () => ({ error: { message: 'denied' } }) })
    await expect(createSupabaseExplanationCache(client).setMany!([{ key: 'k', value: 'v' }])).resolves.toBeUndefined()
  })
})
