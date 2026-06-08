// Per-title quality gate. Accuracy + richness first: a title only enters the catalogue if it has the
// fields a good recommendation card needs AND an active, linkable availability on the target platform.
// Borderline titles are reported with a reason (never silently dropped).

import type { CatalogSkipReason, IngestedTitle } from '@/lib/sync/catalog/types'

export type QualityResult = { ok: true } | { ok: false; reason: CatalogSkipReason }

/** Enforces the minimum-quality bar for an ingested title. Pure + unit-testable. */
export function qualityGate(title: IngestedTitle): QualityResult {
  if (!title.title?.trim()) return { ok: false, reason: 'validation_failed' }
  if (title.genres.length === 0) return { ok: false, reason: 'no_genres' }
  if (!title.description) return { ok: false, reason: 'missing_description' }
  if (!title.posterUrl) return { ok: false, reason: 'missing_poster' }
  const linkable = title.availability.some((a) => a.deepLink && a.deepLink.trim().length > 0)
  if (!linkable) return { ok: false, reason: 'no_active_availability' }
  return { ok: true }
}
