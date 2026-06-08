// Accuracy audit — three automated layers + a deterministic verdict. Runs at the end of every ingest.
// Network calls are injected so the verdict logic and layer aggregation are unit-testable without I/O.
//
//   Layer 1  Internal consistency — re-query motn for a sample; the stored availability must still match.
//   Layer 2  Deep-link liveness  — sample of stored deep links must be reachable (404/410 = dead).
//   Layer 3  Cross-source        — for titles with a tmdbId, compare against TMDb watch/providers (GB).
//
// Healthy runs (verdict 'pass') need zero human interaction; only 'needs_review'/'fail' pull a human in.

import { type Logger, noopLogger } from '@/lib/types/logger'
import {
  type AuditLayerResult,
  type AuditReport,
  type AuditThresholds,
  type AuditVerdict,
  DEFAULT_AUDIT_THRESHOLDS,
} from '@/lib/sync/catalog/types'
import type { ContentType } from '@/lib/types/sync'

export type AuditSampleItem = {
  motnId: string
  tmdbId: number | null
  type: ContentType
  title: string
  deepLink: string | null
}

export type AuditDeps = {
  /** Re-fetch a show from motn; return whether the platform availability is still present. */
  requeryConsistent: (item: AuditSampleItem) => Promise<boolean>
  /** True when the deep link is reachable (treat geo-block / 401 / 403 as reachable; 404/410 = dead). */
  checkLink: (url: string) => Promise<boolean>
  /** True/false if TMDb providers (GB) agree the title is on the platform; null when not checkable. */
  crossCheck: (item: AuditSampleItem) => Promise<boolean | null>
  thresholds?: AuditThresholds
  logger?: Logger
}

type Band = 'ok' | 'review' | 'fail'

function band(rate: number | null, pass: number, fail: number): Band {
  if (rate == null) return 'ok' // nothing checkable → don't penalize
  if (rate >= pass) return 'ok'
  if (rate >= fail) return 'review'
  return 'fail'
}

/** Cross-source uses disagreement (lower is better). */
function disagreementBand(disagreement: number | null, pass: number, fail: number): Band {
  if (disagreement == null) return 'ok'
  if (disagreement <= pass) return 'ok'
  if (disagreement <= fail) return 'review'
  return 'fail'
}

/** PURE: combine the three layers' rates into a verdict. */
export function computeVerdict(
  internalRate: number | null,
  deepLinkRate: number | null,
  crossDisagreement: number | null,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS
): AuditVerdict {
  const bands: Band[] = [
    band(internalRate, thresholds.internalConsistency.pass, thresholds.internalConsistency.fail),
    band(deepLinkRate, thresholds.deepLinkLiveness.pass, thresholds.deepLinkLiveness.fail),
    disagreementBand(crossDisagreement, thresholds.crossSourceDisagreement.pass, thresholds.crossSourceDisagreement.fail),
  ]
  if (bands.includes('fail')) return 'fail'
  if (bands.includes('review')) return 'needs_review'
  return 'pass'
}

function rate(passed: number, checked: number): number | null {
  return checked > 0 ? passed / checked : null
}

export async function runAudit(sample: AuditSampleItem[], deps: AuditDeps): Promise<AuditReport> {
  const logger = deps.logger ?? noopLogger
  const thresholds = deps.thresholds ?? DEFAULT_AUDIT_THRESHOLDS

  const internal: AuditLayerResult = { checked: 0, passed: 0, rate: null, failures: [] }
  const links: AuditLayerResult = { checked: 0, passed: 0, rate: null, failures: [] }
  const cross: AuditLayerResult = { checked: 0, passed: 0, rate: null, failures: [] }

  for (const item of sample) {
    // Layer 1
    try {
      internal.checked++
      if (await deps.requeryConsistent(item)) internal.passed++
      else internal.failures.push(item.title)
    } catch (err) {
      internal.failures.push(item.title)
      logger.warn('audit: requery failed', { motnId: item.motnId, message: err instanceof Error ? err.message : String(err) })
    }

    // Layer 2
    if (item.deepLink) {
      try {
        links.checked++
        if (await deps.checkLink(item.deepLink)) links.passed++
        else links.failures.push(item.title)
      } catch {
        // Network hiccup on our side → treat as reachable (don't fail availability on our connectivity).
        links.passed++
      }
    }

    // Layer 3
    if (item.tmdbId != null) {
      try {
        const agree = await deps.crossCheck(item)
        if (agree === null) continue
        cross.checked++
        if (agree) cross.passed++
        else cross.failures.push(item.title)
      } catch (err) {
        logger.warn('audit: cross-check failed', { tmdbId: item.tmdbId, message: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  internal.rate = rate(internal.passed, internal.checked)
  links.rate = rate(links.passed, links.checked)
  cross.rate = rate(cross.passed, cross.checked)
  const crossDisagreement = cross.rate == null ? null : 1 - cross.rate

  const verdict = computeVerdict(internal.rate, links.rate, crossDisagreement, thresholds)

  return {
    verdict,
    internalConsistency: internal,
    deepLinkLiveness: links,
    crossSource: cross,
    sampleSize: sample.length,
    thresholds,
    ranAt: new Date().toISOString(),
  }
}
