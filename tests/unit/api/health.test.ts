import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fake the Supabase server client (also avoids loading next/headers under vitest). Behavior is driven by
// the hoisted state so each test can make the DB ping succeed, return an error, or make the client throw.
const h = vi.hoisted(() => ({
  dbResult: { data: [{ slug: 'netflix' }], error: null } as { data: unknown; error: unknown },
  createThrows: false,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (h.createThrows) throw new Error('cannot reach supabase')
    return { from: () => ({ select: () => ({ limit: async () => h.dbResult }) }) }
  },
}))

import { GET } from '@/app/api/health/route'
import { __resetReleaseCacheForTests } from '@/lib/utils/observability'
import { __resetFlagCacheForTests } from '@/lib/flags'
import { __setDistributedStoreForTests, InMemoryStore } from '@/lib/utils/distributed-store'

async function getHealth() {
  const res = await GET()
  return { status: res.status, cacheControl: res.headers.get('cache-control'), body: await res.json() }
}

beforeEach(() => {
  h.dbResult = { data: [{ slug: 'netflix' }], error: null }
  h.createThrows = false
  __resetReleaseCacheForTests()
  __resetFlagCacheForTests()
  __setDistributedStoreForTests(new InMemoryStore())
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abcdef0123456789abcdef0123456789abcdef01') // → short 'abcdef0'
})

afterEach(() => {
  __setDistributedStoreForTests(undefined)
  __resetFlagCacheForTests()
  vi.unstubAllEnvs()
})

describe('GET /api/health', () => {
  it('reports ok with all checks, release, and flags when healthy', async () => {
    const { status, cacheControl, body } = await getHealth()

    expect(status).toBe(200)
    expect(cacheControl).toBe('no-store')
    expect(body.status).toBe('ok')
    expect(body.checks.database).toMatchObject({ ok: true })
    expect(typeof body.checks.database.latencyMs).toBe('number')
    expect(body.checks.distributedStore).toMatchObject({ ok: true, backend: 'memory' })
    expect(body.release).toBe('abcdef0')
    expect(body.flags).toMatchObject({ explanations_llm: true })
    expect(typeof body.timestamp).toBe('string')
  })

  it('returns 503 / error when the database query errors', async () => {
    h.dbResult = { data: null, error: { message: 'connection refused' } }
    const { status, body } = await getHealth()

    expect(status).toBe(503)
    expect(body.status).toBe('error')
    expect(body.checks.database.ok).toBe(false)
  })

  it('returns 503 when the Supabase client cannot be created', async () => {
    h.createThrows = true
    const { status, body } = await getHealth()

    expect(status).toBe(503)
    expect(body.checks.database.ok).toBe(false)
  })

  it('is degraded (200) when the store is unreachable but the DB is fine', async () => {
    __setDistributedStoreForTests({
      getJson: async () => {
        throw new Error('redis unreachable')
      },
      setJson: async () => {},
      incrementWindow: async () => ({ count: 0, resetAt: 0 }),
      del: async () => {},
    })

    const { status, body } = await getHealth()
    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
    expect(body.checks.distributedStore.ok).toBe(false)
    expect(body.checks.database.ok).toBe(true)
  })

  it('exposes no sensitive data', async () => {
    const { body } = await getHealth()
    const serialized = JSON.stringify(body).toLowerCase()
    for (const secret of ['token', 'secret', 'password', 'service_role', 'anon_key', 'supabase_url', 'dsn', 'apikey']) {
      expect(serialized).not.toContain(secret)
    }
  })
})
