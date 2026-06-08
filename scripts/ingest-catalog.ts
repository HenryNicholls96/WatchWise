// scripts/ingest-catalog.ts — reusable catalogue ingestion driver.
//
//   npx tsx --env-file=.env.local scripts/ingest-catalog.ts --platform=iplayer --mode=subset --limit=250
//
// Modes: subset (capped first wave) | expand (full) | refresh (full + removal sweep).
// Automation: the accuracy audit runs at the end of EVERY run. expand/refresh are AUTO-BLOCKED unless the
// latest run for this platform/region passed the audit — override only with:
//   --force --operator=<name> --reason="<why>"
// Healthy runs need zero interaction; failures alert via Sentry + a detailed report in sync_jobs.metadata.

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import axios from 'axios'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createCatalogSource } from '@/lib/sync/catalog/motn-source'
import { createOmdbClient } from '@/lib/sync/omdb-client'
import { CATALOG_PLATFORMS, getCatalogPlatform } from '@/lib/sync/catalog/platforms'
import { ingestCatalog } from '@/lib/sync/catalog/pipeline'
import type { IngestMode } from '@/lib/sync/catalog/types'
import { captureMessage, flushErrorReporting, initErrorReporting } from '@/lib/utils/error-reporting'
import { consoleLogger } from '@/lib/types/logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`\n❌ Missing env: ${missing.join(', ')}\n   Run with: npx tsx --env-file=.env.local scripts/ingest-catalog.ts ...\n`)
    process.exit(1)
  }
}

/** TMDb watch/providers cross-check: does the region list BBC iPlayer for this title? null if unknown. */
function makeTmdbProviders(apiKey: string, platformName: RegExp) {
  return async (tmdbId: number, type: 'movie' | 'series', region: string): Promise<boolean | null> => {
    try {
      const path = type === 'movie' ? 'movie' : 'tv'
      const res = await axios.get(`https://api.themoviedb.org/3/${path}/${tmdbId}/watch/providers?api_key=${apiKey}`, {
        timeout: 15_000,
        validateStatus: () => true,
      })
      if (res.status !== 200) return null
      const block = res.data?.results?.[region.toUpperCase()]
      if (!block) return false
      const names: string[] = [...(block.flatrate ?? []), ...(block.free ?? []), ...(block.ads ?? [])].map(
        (p: { provider_name: string }) => p.provider_name
      )
      return names.some((n) => platformName.test(n))
    } catch {
      return null
    }
  }
}

/** Deep-link liveness: 404/410 = dead; everything else (incl. geo-block / 401 / 403) = reachable. */
async function checkLink(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { timeout: 10_000, maxRedirects: 5, validateStatus: () => true })
    return res.status !== 404 && res.status !== 410
  } catch {
    return true // our-side network issue → don't fail availability on connectivity
  }
}

async function latestVerdict(supabase: AnyClient, platform: string, region: string): Promise<string | null> {
  const { data } = await supabase
    .from('sync_jobs')
    .select('metadata')
    .eq('job_type', 'catalog_sync')
    .order('created_at', { ascending: false })
    .limit(20)
  for (const row of (data as { metadata: Record<string, unknown> }[] | null) ?? []) {
    const m = row.metadata ?? {}
    if (m.platform === platform && m.region === region) {
      const audit = m.audit as { verdict?: string } | undefined
      return audit?.verdict ?? null
    }
  }
  return null
}

async function main() {
  const platformSlug = arg('platform') ?? 'iplayer'
  const mode = (arg('mode') ?? 'subset') as IngestMode
  const limitStr = arg('limit')
  const limit = limitStr ? Number(limitStr) : mode === 'subset' ? 250 : undefined
  const force = flag('force')
  const operator = arg('operator') ?? process.env.USERNAME ?? process.env.USER ?? 'unknown'
  const reason = arg('reason')

  const platform = getCatalogPlatform(platformSlug)
  if (!platform) {
    console.error(`Unknown platform "${platformSlug}". Known: ${Object.keys(CATALOG_PLATFORMS).join(', ')}`)
    process.exit(1)
  }

  requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STREAMING_API_KEY', 'STREAMING_API_BASE_URL', 'TMDB_API_KEY'])
  initErrorReporting()

  const supabase: AnyClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // ─── Automated gate: block expand/refresh unless the last run passed ─────────
  if (mode === 'expand' || mode === 'refresh') {
    const prev = await latestVerdict(supabase, platform.slug, platform.region)
    if (prev !== 'pass' && prev !== null) {
      if (!force) {
        console.error(
          `\n⛔ Blocked: latest ${platform.slug}/${platform.region} audit verdict is "${prev}".\n` +
            `   Resolve it, or override with: --force --operator=<name> --reason="<why>"\n`
        )
        process.exit(1)
      }
      if (!reason) {
        console.error('\n⛔ --force requires --reason="<why>" (records who overrode and why).\n')
        process.exit(1)
      }
      console.warn(`⚠ FORCE override by ${operator}: ${reason} (prior verdict: ${prev})`)
    }
  }

  const source = createCatalogSource(process.env.STREAMING_API_KEY!, process.env.STREAMING_API_BASE_URL!, { logger: consoleLogger })
  const omdb = process.env.OMDB_API_KEY ? createOmdbClient(process.env.OMDB_API_KEY) : null
  const tmdbProviders = makeTmdbProviders(process.env.TMDB_API_KEY!, /bbc\s*iplayer/i)

  console.log(`\n━━━ Catalog ingest: ${platform.name} (${platform.slug}/${platform.region}) — mode=${mode} limit=${limit ?? '∞'} ━━━\n`)

  const result = await ingestCatalog(
    { platformSlug: platform.slug, mode, limit },
    {
      supabase,
      source,
      getOmdb: omdb ? (id) => omdb.getByImdbId(id) : undefined,
      tmdbProviders,
      checkLink,
      logger: consoleLogger,
    }
  )

  console.log('\n── Result ──')
  console.log(`enumerated: ${result.enumerated} | written: ${result.written} | removed: ${result.removed}`)
  console.log(`skipped: ${JSON.stringify(result.skipped)}`)
  if (result.audit) {
    const a = result.audit
    const pct = (r: number | null) => (r == null ? 'n/a' : `${Math.round(r * 100)}%`)
    console.log(`audit verdict: ${a.verdict.toUpperCase()} (sample ${a.sampleSize})`)
    console.log(`  internal-consistency: ${pct(a.internalConsistency.rate)} | deep-link: ${pct(a.deepLinkLiveness.rate)} | cross-source agree: ${pct(a.crossSource.rate)}`)
  }

  // Record a force override on this run's job for the audit trail.
  if (force && reason && result.jobId) {
    const { data } = await supabase.from('sync_jobs').select('metadata').eq('id', result.jobId).single()
    const meta = (data?.metadata as Record<string, unknown>) ?? {}
    await supabase
      .from('sync_jobs')
      .update({ metadata: { ...meta, override: { operator, reason, at: new Date().toISOString() } } })
      .eq('id', result.jobId)
  }

  if (result.verdict !== 'pass') {
    captureMessage(`Catalog ingest ${platform.slug}/${platform.region}: audit ${result.verdict}`, {
      route: 'scripts/ingest-catalog',
      level: result.verdict === 'fail' ? 'error' : 'warning',
      errorCode: `audit_${result.verdict}`,
    })
    await flushErrorReporting()
    console.error(`\n⚠ Audit verdict "${result.verdict}" — progression blocked until resolved. Report in sync_jobs.metadata.audit (job ${result.jobId}).\n`)
    process.exit(result.verdict === 'fail' ? 1 : 2)
  }

  console.log(`\n✓ Done — audit PASS. Job ${result.jobId}.\n`)
}

main().catch((err) => {
  console.error(`Pipeline crashed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
