// Filters — step 3 of the recommendation pipeline.
//
// Applies hard, non-negotiable filters to retrieval candidates. A hard filter is a
// binary eligibility gate (not a score): platform availability, content type, runtime,
// and explicit exclusions (already-seen / not-interested). Anything that fails is removed
// entirely — these are correctness constraints, not preferences.
//
// Design:
//   • Pure predicate functions for the I/O-free filters (type, runtime, exclusions) so
//     they are trivially unit-testable with fixtures.
//   • A single batched DB lookup for platform availability (one query, not N).
//   • Dependency injection of the Supabase client + logger, matching retrieval.ts.
//
// Improvement over recommendation-engine.md: the doc applies the runtime cap to movies
// only. We also apply it to series via avg_episode_minutes, which directly serves the
// product's "under 45 min episodes" use case. Missing runtime data never excludes a title
// (fail-open) — we don't penalize a candidate for absent metadata.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Candidate, type ContentType } from '@/lib/types/content'
import { type Logger, noopLogger } from '@/lib/types/logger'

// ─── Errors ───────────────────────────────────────────────────────────────────

export type FilterErrorCode = 'INVALID_INPUT' | 'AVAILABILITY_LOOKUP_FAILED'

export class FilterError extends Error {
  readonly code: FilterErrorCode
  override readonly cause?: unknown
  constructor(code: FilterErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'FilterError'
    this.code = code
    this.cause = cause
  }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

export type FilterInput = {
  candidates: Candidate[]
  /** Platform slugs the user can watch (e.g. ['netflix','prime']). Empty = no platform gate. */
  platformSlugs: string[]
  region: string
  /** Restrict to a single content type. Undefined = any. */
  contentType?: ContentType
  /** Max runtime: movies by runtime, series by avg episode length. Undefined = no cap. */
  maxRuntimeMinutes?: number
  /** Content IDs to drop (already-seen, not-interested). */
  excludeContentIds?: string[]
  /** Canonical genre / tag terms to exclude (from negative intent, e.g. ['Horror']). */
  excludeGenres?: string[]
  /** Genres a title MUST include to be eligible (e.g. ['Documentary'] for the Documentaries media type). */
  requireGenres?: string[]
  /** Content IDs exempt from genre exclusion (e.g. titles the user explicitly liked). */
  protectContentIds?: string[]
  /** Restrict to a single original language (ISO 639-1, e.g. 'en'). Undefined = any. */
  originalLanguage?: string
}

export type FilterDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>
  logger?: Logger
}

// ─── Pure predicate filters (no I/O) ──────────────────────────────────────────

/** Keeps only candidates of the requested content type. No-op if type is undefined. */
export function filterByContentType(candidates: Candidate[], contentType?: ContentType): Candidate[] {
  if (!contentType) return candidates
  return candidates.filter((c) => c.content.type === contentType)
}

/**
 * Keeps candidates within the runtime cap. Movies are judged by runtimeMinutes,
 * series by avgEpisodeMinutes. A title with no relevant runtime value is KEPT
 * (fail-open) — absent metadata must not silently drop otherwise-valid content.
 */
export function filterByRuntime(candidates: Candidate[], maxRuntimeMinutes?: number): Candidate[] {
  if (maxRuntimeMinutes == null) return candidates
  return candidates.filter((c) => {
    const runtime = c.content.type === 'movie' ? c.content.runtimeMinutes : c.content.avgEpisodeMinutes
    return runtime == null || runtime <= maxRuntimeMinutes
  })
}

/** Removes candidates whose content id is in the exclusion set. */
export function filterByExclusions(candidates: Candidate[], excludeContentIds?: string[]): Candidate[] {
  if (!excludeContentIds || excludeContentIds.length === 0) return candidates
  const excluded = new Set(excludeContentIds)
  return candidates.filter((c) => !excluded.has(c.content.id))
}

/**
 * Removes candidates that match any excluded genre/tag term (from negative intent, e.g. "no horror").
 * A term matches if it equals (case-insensitively) any of a title's genres, mood tags, or theme tags,
 * so excluding "horror" drops both Horror-genre titles and horror-tagged ones. A title with no
 * genres/tags is KEPT (fail-open) — absent metadata must not silently exclude content.
 *
 * `protectContentIds` are exempt and always kept: a genre-avoid preference must never hide a title the
 * user explicitly liked.
 */
export function filterByExcludedGenres(
  candidates: Candidate[],
  excludeGenres?: string[],
  protectContentIds?: string[]
): Candidate[] {
  if (!excludeGenres || excludeGenres.length === 0) return candidates
  const excluded = new Set(excludeGenres.map((g) => g.trim().toLowerCase()))
  const protectedIds = new Set(protectContentIds ?? [])
  return candidates.filter((c) => {
    if (protectedIds.has(c.content.id)) return true
    const terms = [...c.content.genres, ...c.content.moodTags, ...c.content.themeTags]
    return !terms.some((t) => excluded.has(t.trim().toLowerCase()))
  })
}

/**
 * Keeps only candidates that include at least one of the required genres (case-insensitive). This is a
 * positive ELIGIBILITY gate (e.g. "Documentaries only"): unlike genre EXCLUSION, a title with no matching
 * genre is DROPPED — we can't assert an untagged/non-matching title belongs. No-op when the set is empty.
 */
export function filterByRequiredGenres(candidates: Candidate[], requireGenres?: string[]): Candidate[] {
  if (!requireGenres || requireGenres.length === 0) return candidates
  const required = new Set(requireGenres.map((g) => g.trim().toLowerCase()))
  return candidates.filter((c) => c.content.genres.some((g) => required.has(g.trim().toLowerCase())))
}

/**
 * Keeps candidates whose original language matches the requested one (ISO 639-1, case-insensitive).
 * A title with no language metadata is KEPT (fail-open) — absent data must not silently exclude.
 */
export function filterByLanguage(candidates: Candidate[], originalLanguage?: string): Candidate[] {
  if (!originalLanguage) return candidates
  const want = originalLanguage.trim().toLowerCase()
  return candidates.filter((c) => {
    const lang = c.content.originalLanguage
    return lang == null || lang.trim().toLowerCase() === want
  })
}

// ─── Platform availability filter (batched I/O) ───────────────────────────────

/**
 * Keeps only candidates currently available on at least one of the user's platforms in
 * the given region. "Currently available" = an active content_platforms row (available_until
 * is null or in the future). Single batched query over all candidate IDs.
 *
 * If platformSlugs is empty, the platform gate is skipped (returns input unchanged).
 */
export async function filterByPlatformAvailability(
  candidates: Candidate[],
  platformSlugs: string[],
  region: string,
  deps: FilterDeps
): Promise<Candidate[]> {
  const logger = deps.logger ?? noopLogger
  if (candidates.length === 0) return candidates
  if (platformSlugs.length === 0) return candidates

  // Resolve platform slugs → ids.
  const { data: platformRows, error: pErr } = await deps.supabase
    .from('platforms')
    .select('id, slug')
    .in('slug', platformSlugs)
  if (pErr) {
    throw new FilterError('AVAILABILITY_LOOKUP_FAILED', `platform lookup failed: ${pErr.message}`, pErr)
  }
  const platformIds = (platformRows ?? []).map((p: { id: string }) => p.id)
  if (platformIds.length === 0) {
    logger.warn('no matching platforms for slugs — filtering everything out', { platformSlugs })
    return []
  }

  const candidateIds = candidates.map((c) => c.content.id)
  const nowIso = new Date().toISOString()

  // One query: which candidate ids have an active row on any of the user's platforms?
  const { data: availRows, error: aErr } = await deps.supabase
    .from('content_platforms')
    .select('content_id, available_until')
    .in('content_id', candidateIds)
    .in('platform_id', platformIds)
    .eq('region', region)
    .or(`available_until.is.null,available_until.gt.${nowIso}`)
  if (aErr) {
    throw new FilterError('AVAILABILITY_LOOKUP_FAILED', `availability lookup failed: ${aErr.message}`, aErr)
  }

  const availableIds = new Set((availRows ?? []).map((r: { content_id: string }) => r.content_id))
  return candidates.filter((c) => availableIds.has(c.content.id))
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Applies all hard filters in sequence and returns the eligible candidates.
 * Order: cheap pure predicates first (shrink the set), then the batched platform query.
 *
 * @throws FilterError on invalid input or a failed availability lookup.
 */
export async function applyHardFilters(input: FilterInput, deps: FilterDeps): Promise<Candidate[]> {
  const logger = deps.logger ?? noopLogger

  if (!input.region?.trim()) {
    throw new FilterError('INVALID_INPUT', 'region is required')
  }

  const before = input.candidates.length

  // Pure predicates first — they require no I/O and reduce the platform-query payload.
  let result = filterByContentType(input.candidates, input.contentType)
  result = filterByRuntime(result, input.maxRuntimeMinutes)
  result = filterByLanguage(result, input.originalLanguage)
  result = filterByRequiredGenres(result, input.requireGenres)
  result = filterByExcludedGenres(result, input.excludeGenres, input.protectContentIds)
  result = filterByExclusions(result, input.excludeContentIds)

  // Platform availability last (the only DB call), over the already-shrunk set.
  result = await filterByPlatformAvailability(result, input.platformSlugs, input.region, deps)

  logger.info('hard filters applied', {
    before,
    after: result.length,
    contentType: input.contentType ?? 'any',
    platforms: input.platformSlugs,
    maxRuntimeMinutes: input.maxRuntimeMinutes ?? null,
    excludeGenres: input.excludeGenres ?? [],
    requireGenres: input.requireGenres ?? [],
  })

  return result
}
