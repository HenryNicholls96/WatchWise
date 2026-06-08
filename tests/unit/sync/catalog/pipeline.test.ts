import { describe, expect, it, vi } from 'vitest'
import { ingestCatalog } from '@/lib/sync/catalog/pipeline'
import type { CatalogSource } from '@/lib/sync/catalog/motn-source'
import type { MotnShow } from '@/lib/sync/catalog/types'

function motnShow(over: Partial<MotnShow> = {}): MotnShow {
  return {
    id: '305914',
    showType: 'movie',
    title: 'Dedupe Movie',
    overview: 'A synopsis.',
    releaseYear: 2021,
    tmdbId: 'movie/872790',
    genres: [{ id: 'drama', name: 'Drama' }],
    cast: ['Someone'],
    directors: ['Dir'],
    imageSet: { verticalPoster: { w480: 'https://img/480.jpg' } },
    streamingOptions: { gb: [{ service: { id: 'iplayer' }, type: 'free', link: 'https://bbc/x', availableSince: 1 }] },
    ...over,
  } as MotnShow
}

// Minimal in-memory Supabase fake covering exactly the chains the pipeline uses.
function makeFake(seed: { content_key: string; id: string; tmdb_id: number | null }[] = []) {
  const content = new Map<string, Record<string, unknown>>()
  for (const s of seed) content.set(s.content_key, { ...s })
  const contentPlatforms: Record<string, unknown>[] = []
  const syncJobs: Record<string, unknown>[] = []
  const platforms = [{ id: 'p-ip', slug: 'iplayer' }]
  let idc = 0
  const genKey = (f: Record<string, unknown>) => (f.tmdb_id != null ? `tmdb:${f.tmdb_id}` : `motn:${f.motn_id}`)

  function from(table: string) {
    let op: string | null = null
    let fields: Record<string, unknown> | Record<string, unknown>[] | null = null
    const filters: Record<string, unknown> = {}
    const api: Record<string, unknown> = {
      select: () => (op ?? (op = 'select'), api),
      insert: (f: Record<string, unknown>) => ((op = 'insert'), (fields = f), api),
      update: (f: Record<string, unknown>) => ((op = 'update'), (fields = f), api),
      delete: () => ((op = 'delete'), api),
      eq: (k: string, v: unknown) => ((filters[k] = v), api),
      or: () => api,
      order: () => api,
      limit: () => api,
      upsert: async (rows: Record<string, unknown>[]) => {
        for (const r of rows) {
          const i = contentPlatforms.findIndex(
            (x) => x.content_id === r.content_id && x.platform_id === r.platform_id && x.region === r.region
          )
          if (i >= 0) contentPlatforms[i] = { ...contentPlatforms[i], ...r }
          else contentPlatforms.push(r)
        }
        return { error: null }
      },
      single: async () => {
        if (table === 'sync_jobs' && op === 'insert') {
          const id = `job-${++idc}`
          syncJobs.push({ id, ...(fields as object) })
          return { data: { id }, error: null }
        }
        if (table === 'content' && op === 'insert') {
          const f = fields as Record<string, unknown>
          const id = `c-${++idc}`
          content.set(genKey(f), { id, ...f })
          return { data: { id }, error: null }
        }
        return { data: null, error: null }
      },
      maybeSingle: async () => {
        if (table === 'content' && filters.content_key !== undefined) {
          const ex = content.get(filters.content_key as string)
          return { data: ex ? { id: ex.id } : null, error: null }
        }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let result: unknown = { data: [], error: null }
        if (table === 'tag_mappings') result = { data: [], error: null }
        else if (table === 'platforms') result = { data: platforms, error: null }
        else if (table === 'content' && op === 'update') {
          for (const [k, v] of content) if ((v as { id: string }).id === filters.id) content.set(k, { ...v, ...(fields as object) })
          result = { error: null }
        } else if (table === 'content_platforms' && op === 'delete') result = { data: [], error: null }
        else if (table === 'sync_jobs' && op === 'update') {
          const j = syncJobs.find((s) => s.id === filters.id)
          if (j) Object.assign(j, fields as object)
          result = { error: null }
        }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return api
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, content, contentPlatforms, syncJobs }
}

function makeSource(shows: MotnShow[]): CatalogSource {
  const byId = new Map(shows.map((s) => [s.id, s]))
  return {
    listPage: async ({ cursor }) => (cursor ? { shows: [], hasMore: false, nextCursor: null } : { shows, hasMore: false, nextCursor: null }),
    getShow: async (id) => byId.get(id) ?? null,
  }
}

describe('ingestCatalog', () => {
  it('dedupes against an existing TMDb row, ingests a BBC original, and skips low-quality titles', async () => {
    const fake = makeFake([{ content_key: 'tmdb:872790', id: 'c-us', tmdb_id: 872790 }]) // pre-existing US row
    const shows = [
      motnShow(), // same tmdbId 872790 → should UPDATE c-us, add iplayer availability (no new row)
      motnShow({ id: '999', title: 'BBC Original', tmdbId: undefined, showType: 'series' }), // motn:999 → new row
      motnShow({ id: '777', title: 'No Synopsis', tmdbId: undefined, overview: undefined }), // skipped: missing_description
    ]

    const result = await ingestCatalog(
      { platformSlug: 'iplayer', mode: 'subset', limit: 50 },
      {
        supabase: fake.client,
        source: makeSource(shows),
        tmdbProviders: vi.fn().mockResolvedValue(true),
        checkLink: vi.fn().mockResolvedValue(true),
        logger: undefined,
      }
    )

    expect(result.written).toBe(2)
    expect(result.skipped.missing_description).toBe(1)
    // Dedupe: still exactly two content rows (the pre-existing US one + the BBC original) — no duplicate.
    expect(fake.content.size).toBe(2)
    expect(fake.content.has('tmdb:872790')).toBe(true)
    expect(fake.content.has('motn:999')).toBe(true)
    // The US row gained an iPlayer/gb availability row.
    expect(fake.contentPlatforms.some((r) => r.content_id === 'c-us' && r.platform_id === 'p-ip' && r.region === 'gb')).toBe(true)
  })

  it('runs the audit automatically and records a passing verdict on the sync job', async () => {
    const fake = makeFake()
    const result = await ingestCatalog(
      { platformSlug: 'iplayer', mode: 'subset', limit: 50 },
      {
        supabase: fake.client,
        source: makeSource([motnShow()]),
        tmdbProviders: vi.fn().mockResolvedValue(true),
        checkLink: vi.fn().mockResolvedValue(true),
      }
    )
    expect(result.verdict).toBe('pass')
    expect(result.audit?.internalConsistency.passed).toBe(1)
    const job = fake.syncJobs[0] as { status: string; metadata: { audit: { verdict: string } } }
    expect(job.status).toBe('completed')
    expect(job.metadata.audit.verdict).toBe('pass')
  })

  it('records a failing audit verdict (failed job) when re-query consistency collapses', async () => {
    const fake = makeFake()
    // getShow returns a show with NO iplayer option → internal-consistency check fails for every sampled title.
    const source: CatalogSource = {
      listPage: async ({ cursor }) =>
        cursor ? { shows: [], hasMore: false, nextCursor: null } : { shows: [motnShow(), motnShow({ id: '2', tmdbId: 'movie/2' })], hasMore: false, nextCursor: null },
      getShow: async () => motnShow({ streamingOptions: { gb: [{ service: { id: 'netflix' }, type: 'subscription' }] } }),
    }
    const result = await ingestCatalog(
      { platformSlug: 'iplayer', mode: 'subset', limit: 50 },
      { supabase: fake.client, source, tmdbProviders: vi.fn().mockResolvedValue(true), checkLink: vi.fn().mockResolvedValue(true) }
    )
    expect(result.verdict).toBe('fail')
    const job = fake.syncJobs[0] as { status: string }
    expect(job.status).toBe('failed')
  })
})
