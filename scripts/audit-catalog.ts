// scripts/audit-catalog.ts — run the accuracy audit on demand against already-ingested catalogue data.
//
//   npx tsx --env-file=.env.local scripts/audit-catalog.ts --platform=iplayer [--sample=30]
//
// Useful for re-checking a platform between ingests, or after fixing a `needs_review` cause. Prints the
// verdict + per-layer metrics and the quarantined titles. Read-only (writes nothing).

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import axios from 'axios'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createCatalogSource } from '@/lib/sync/catalog/motn-source'
import { getCatalogPlatform } from '@/lib/sync/catalog/platforms'
import { type AuditSampleItem, runAudit } from '@/lib/sync/catalog/audit'
import { consoleLogger } from '@/lib/types/logger'
import type { ContentType } from '@/lib/types/sync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

async function checkLink(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { timeout: 10_000, maxRedirects: 5, validateStatus: () => true })
    return res.status !== 404 && res.status !== 410
  } catch {
    return true
  }
}

function makeTmdbProviders(apiKey: string, name: RegExp) {
  return async (tmdbId: number, type: ContentType, region: string): Promise<boolean | null> => {
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
      return names.some((n) => name.test(n))
    } catch {
      return null
    }
  }
}

async function main() {
  const platformSlug = arg('platform') ?? 'iplayer'
  const sampleSize = Number(arg('sample') ?? '30')
  const platform = getCatalogPlatform(platformSlug)
  if (!platform) {
    console.error(`Unknown platform "${platformSlug}"`)
    process.exit(1)
  }
  for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STREAMING_API_KEY', 'STREAMING_API_BASE_URL', 'TMDB_API_KEY']) {
    if (!process.env[k]) {
      console.error(`Missing env: ${k}`)
      process.exit(1)
    }
  }

  const supabase: AnyClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: plat } = await supabase.from('platforms').select('id').eq('slug', platform.slug).single()
  if (!plat) {
    console.error(`Platform "${platform.slug}" not in DB — run an ingest first.`)
    process.exit(1)
  }

  const { data: rows } = await supabase
    .from('content_platforms')
    .select('deep_link, content:content_id (motn_id, tmdb_id, type, title)')
    .eq('platform_id', (plat as { id: string }).id)
    .eq('region', platform.region)
    .limit(500)

  type Joined = { deep_link: string | null; content: { motn_id: string | null; tmdb_id: number | null; type: ContentType; title: string } | null }
  const sample: AuditSampleItem[] = ((rows as Joined[] | null) ?? [])
    .filter((r) => r.content?.motn_id)
    .map((r) => ({
      motnId: r.content!.motn_id!,
      tmdbId: r.content!.tmdb_id,
      type: r.content!.type,
      title: r.content!.title,
      deepLink: r.deep_link,
    }))
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize)

  if (sample.length === 0) {
    console.error('No ingested catalogue rows to audit.')
    process.exit(1)
  }

  const source = createCatalogSource(process.env.STREAMING_API_KEY!, process.env.STREAMING_API_BASE_URL!, { logger: consoleLogger })
  const tmdbProviders = makeTmdbProviders(process.env.TMDB_API_KEY!, /bbc\s*iplayer/i)

  const report = await runAudit(sample, {
    logger: consoleLogger,
    requeryConsistent: async (item) => {
      const show = await source.getShow(item.motnId, platform.region)
      if (!show) return false
      return (show.streamingOptions?.[platform.region] ?? []).some((o) => o.service.id === platform.slug)
    },
    checkLink,
    crossCheck: async (item) => (item.tmdbId != null ? tmdbProviders(item.tmdbId, item.type, platform.region) : null),
  })

  const pct = (r: number | null) => (r == null ? 'n/a' : `${Math.round(r * 100)}%`)
  console.log(`\nAudit ${platform.slug}/${platform.region}: ${report.verdict.toUpperCase()} (sample ${report.sampleSize})`)
  console.log(`  internal-consistency: ${pct(report.internalConsistency.rate)} (${report.internalConsistency.passed}/${report.internalConsistency.checked})`)
  console.log(`  deep-link liveness:   ${pct(report.deepLinkLiveness.rate)} (${report.deepLinkLiveness.passed}/${report.deepLinkLiveness.checked})`)
  console.log(`  cross-source agree:   ${pct(report.crossSource.rate)} (${report.crossSource.passed}/${report.crossSource.checked})`)
  const quarantined = [...report.internalConsistency.failures, ...report.crossSource.failures]
  if (quarantined.length) console.log(`  quarantined: ${[...new Set(quarantined)].slice(0, 15).join(', ')}`)

  process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2)
}

main().catch((err) => {
  console.error(`Audit crashed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
