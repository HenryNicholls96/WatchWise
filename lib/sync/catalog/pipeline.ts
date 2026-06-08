// Catalog ingestion pipeline — the reusable orchestrator. Platform-agnostic: parameterized by a
// platform slug (resolved via the registry) and a CatalogSource, so adding ITVX/Channel 4 later is
// config + a `platforms` row, not new pipeline code.
//
// Order: enumerate → validate(boundary) → normalize → quality-gate → enrich(best-effort) → upsert
//        → (refresh) removal-detection → AUTOMATED AUDIT → finalize sync_job.
// Fail-open per title: one bad/again-failing title never aborts the run.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Logger, noopLogger } from '@/lib/types/logger'
import type { OmdbRatings } from '@/lib/sync/omdb-client'
import type { TagMapping } from '@/lib/types/sync'
import { loadTagMappings } from '@/lib/sync/keyword-mapper'
import { type EnrichDeps, enrichTitle } from '@/lib/sync/catalog/enrich'
import { normalizeShow } from '@/lib/sync/catalog/normalize'
import { qualityGate } from '@/lib/sync/catalog/validate'
import { loadPlatformIdBySlug, upsertTitle } from '@/lib/sync/catalog/upsert'
import { type AuditSampleItem, runAudit } from '@/lib/sync/catalog/audit'
import { getCatalogPlatform } from '@/lib/sync/catalog/platforms'
import type { CatalogSource } from '@/lib/sync/catalog/motn-source'
import {
  type CatalogSkipReason,
  type IngestMode,
  type IngestResult,
  DEFAULT_AUDIT_THRESHOLDS,
} from '@/lib/sync/catalog/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

const DEFAULT_AUDIT_SAMPLE = 30
const PAGE_HARD_CAP = 60 // safety bound on enumeration pages

export type IngestOptions = {
  platformSlug: string
  mode: IngestMode
  /** Cap on titles written (subset wave). Omit for full coverage (expand/refresh). */
  limit?: number
  auditSampleSize?: number
  thresholds?: typeof DEFAULT_AUDIT_THRESHOLDS
}

export type IngestDeps = {
  supabase: AnyClient
  source: CatalogSource
  /** Best-effort OMDb ratings (blended rating). */
  getOmdb?: (imdbId: string) => Promise<OmdbRatings>
  /** Cross-source check: does TMDb watch/providers (region) agree the title is on the platform? */
  tmdbProviders?: (tmdbId: number, type: 'movie' | 'series', region: string) => Promise<boolean | null>
  /** Deep-link liveness check (reachable? 404/410 = dead). */
  checkLink?: (url: string) => Promise<boolean>
  logger?: Logger
  now?: () => Date
}

function shuffleSample<T>(items: T[], n: number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, n)
}

export async function ingestCatalog(opts: IngestOptions, deps: IngestDeps): Promise<IngestResult> {
  const logger = deps.logger ?? noopLogger
  const now = deps.now ?? (() => new Date())
  const runAt = now()
  const platform = getCatalogPlatform(opts.platformSlug)
  if (!platform) throw new Error(`Unknown catalog platform: ${opts.platformSlug}`)
  const { region, motnCatalog, slug } = platform

  const skipped: Partial<Record<CatalogSkipReason, number>> = {}
  const bump = (r: CatalogSkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1)

  // Sync job (best-effort id; pipeline still runs if tracking insert fails).
  let jobId: string | null = null
  try {
    const { data } = await deps.supabase
      .from('sync_jobs')
      .insert({
        job_type: 'catalog_sync',
        status: 'running',
        started_at: runAt.toISOString(),
        metadata: { platform: slug, region, mode: opts.mode },
      })
      .select('id')
      .single()
    jobId = (data?.id as string) ?? null
  } catch (err) {
    logger.warn('catalog: sync_job insert failed (continuing)', { message: err instanceof Error ? err.message : String(err) })
  }

  const tagMappings: TagMapping[] = await loadTagMappings(deps.supabase).catch(() => [] as TagMapping[])
  const platformIdBySlug = await loadPlatformIdBySlug(deps.supabase)
  const enrichDeps: EnrichDeps = { getOmdb: deps.getOmdb, tagMappings, logger }

  const writtenSample: AuditSampleItem[] = []
  let enumerated = 0
  let written = 0
  const limit = opts.limit ?? Infinity

  let cursor: string | null = null
  let pages = 0
  for (;;) {
    if (written >= limit || pages >= PAGE_HARD_CAP) break
    const page = await deps.source.listPage({ country: region, catalog: motnCatalog, cursor })
    pages++
    for (const show of page.shows) {
      enumerated++
      const title = normalizeShow(show, slug, region)
      if (!title) {
        bump('no_active_availability')
        continue
      }
      const gate = qualityGate(title)
      if (!gate.ok) {
        bump(gate.reason)
        continue
      }
      const enriched = await enrichTitle(title, enrichDeps)
      const outcome = await upsertTitle(deps.supabase, title, enriched, platformIdBySlug, runAt, { logger })
      if (!outcome) continue
      written++
      writtenSample.push({
        motnId: title.motnId,
        tmdbId: title.tmdbId,
        type: title.type,
        title: title.title,
        deepLink: title.availability[0]?.deepLink ?? null,
      })
      if (written >= limit) break
    }
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }

  // Removal detection — only on a full refresh (never on a capped subset, which intentionally ignores
  // titles outside the wave). Drop availability rows for this platform/region not re-confirmed this run.
  let removed = 0
  if (opts.mode === 'refresh' && opts.limit == null) {
    const platformId = platformIdBySlug.get(slug)
    if (platformId) {
      const { data, error } = await deps.supabase
        .from('content_platforms')
        .delete()
        .eq('platform_id', platformId)
        .eq('region', region)
        .or(`last_seen_at.is.null,last_seen_at.lt.${runAt.toISOString()}`)
        .select('id')
      if (error) logger.warn('catalog: removal sweep failed', { message: error.message })
      else removed = (data as { id: string }[] | null)?.length ?? 0
    }
  }

  // ─── Automated accuracy audit (every run) ───────────────────────────────────
  const sampleSize = Math.min(opts.auditSampleSize ?? DEFAULT_AUDIT_SAMPLE, writtenSample.length)
  const sample = shuffleSample(writtenSample, sampleSize)
  const checkLink = deps.checkLink ?? (async () => true)
  const audit =
    sample.length > 0
      ? await runAudit(sample, {
          thresholds: opts.thresholds,
          logger,
          requeryConsistent: async (item) => {
            const show = await deps.source.getShow(item.motnId, region)
            if (!show) return false
            const opts2 = show.streamingOptions?.[region] ?? []
            return opts2.some((o) => o.service.id === slug)
          },
          checkLink,
          crossCheck: async (item) =>
            item.tmdbId != null && deps.tmdbProviders
              ? deps.tmdbProviders(item.tmdbId, item.type, region)
              : null,
        })
      : null

  const verdict = audit?.verdict ?? 'pass'

  // Finalize sync job: a hard audit fail marks the job failed; needs_review still 'completed' but the
  // verdict in metadata is what gates progression.
  if (jobId) {
    try {
      await deps.supabase
        .from('sync_jobs')
        .update({
          status: verdict === 'fail' ? 'failed' : 'completed',
          completed_at: new Date().toISOString(),
          records_processed: written,
          metadata: {
            platform: slug,
            region,
            mode: opts.mode,
            enumerated,
            written,
            removed,
            skipped,
            audit,
          },
        })
        .eq('id', jobId)
    } catch (err) {
      logger.warn('catalog: sync_job finalize failed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { jobId, verdict, enumerated, written, skipped, removed, audit }
}
