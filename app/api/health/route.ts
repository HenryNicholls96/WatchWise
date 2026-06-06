// GET /api/health — lightweight liveness/readiness probe.
//
// Reports DB connectivity, DistributedStore reachability, the current release, and the resolved feature
// flags. Designed to be cheap (two small reads), fast (each check is time-boxed), and SAFE to expose: no
// secrets, no env values, no error strings (failure detail is logged server-side, never returned).
//
// HTTP status: 200 when the DB is reachable (the app can serve recommendations) — even if the store is down,
// since the store is fail-open (limits/breakers/flags degrade gracefully) → 'degraded'. 503 only when the
// DB is unreachable → 'error' (not ready).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDistributedStore, getStoreBackend } from '@/lib/utils/distributed-store'
import { evaluateAllFlags } from '@/lib/flags'
import { getCurrentRelease } from '@/lib/utils/observability'
import { consoleLogger } from '@/lib/types/logger'

// Needs the Node runtime (Supabase SSR client); never cache a health response.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHECK_TIMEOUT_MS = 2_000

type Check = { ok: boolean; latencyMs: number }

export async function GET(): Promise<NextResponse> {
  const [database, store] = await Promise.all([checkDatabase(), checkStore()])
  // Flags are a config snapshot (no subject). evaluateAllFlags is fail-open, but guard defensively.
  const flags = await evaluateAllFlags().catch(() => ({}))

  const status = database.ok && store.ok ? 'ok' : database.ok ? 'degraded' : 'error'
  const httpStatus = database.ok ? 200 : 503

  return NextResponse.json(
    {
      status,
      release: getCurrentRelease(),
      checks: {
        database,
        distributedStore: { ...store, backend: getStoreBackend() },
      },
      flags,
      timestamp: new Date().toISOString(),
    },
    { status: httpStatus, headers: { 'cache-control': 'no-store' } }
  )
}

/** Basic Supabase ping: a tiny read of the public `platforms` table (RLS-safe, ~3 rows). */
async function checkDatabase(): Promise<Check> {
  const start = performance.now()
  try {
    const supabase = await withTimeout(createClient(), CHECK_TIMEOUT_MS)
    const { error } = await withTimeout(supabase.from('platforms').select('slug').limit(1), CHECK_TIMEOUT_MS)
    return { ok: !error, latencyMs: elapsed(start) }
  } catch (err) {
    consoleLogger.warn('health: database check failed', { message: errMessage(err) })
    return { ok: false, latencyMs: elapsed(start) }
  }
}

/** Reachability of the configured DistributedStore (in-memory: instant; Redis: one GET round-trip). */
async function checkStore(): Promise<Check> {
  const start = performance.now()
  try {
    await withTimeout(getDistributedStore().getJson('health:ping'), CHECK_TIMEOUT_MS)
    return { ok: true, latencyMs: elapsed(start) }
  } catch (err) {
    consoleLogger.warn('health: distributed store check failed', { message: errMessage(err) })
    return { ok: false, latencyMs: elapsed(start) }
  }
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), ms)
  })
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), timeout])
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
