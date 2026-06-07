// Scoring — step 4 of the recommendation pipeline.
//
// Turns filtered Candidates into ranked ScoredCandidates with an auditable score breakdown.
// Composite score (per ADR-006 / recommendation-engine.md):
//
//   score = vectorSimilarity × 0.60   (semantic match to the query)
//         + personalization  × 0.25   (taste-seed affinity / aversion)
//         + qualityScore     × 0.15   (rating, discounted by vote confidence)
//
// Each ScoredCandidate also carries a similarity-floor confidence flag so the engine/UI can
// signal "we're not confident about these" when the query matched the catalog poorly.
//
// Design notes vs recommendation-engine.md:
//   • The doc derives personalization from candidate↔seed *embedding* cosine similarity. But
//     ContentRow (and thus Candidate) deliberately omits the 512-dim embedding — retrieval.ts
//     strips it as "never needed downstream" — and the doc's own signature makes scoreAndRank
//     a PURE, synchronous function with no DB access. Threading raw vectors through filters.ts
//     just to recompute similarities would break both invariants. v1 instead measures taste
//     affinity by genre/mood/theme overlap (the doc already uses metadata overlap for the
//     'disliked' case). Embedding-cosine personalization is a clean v2 swap: add embeddings to
//     the seed/candidate types and replace `tagOverlap` — no other step changes.
//   • Missing quality metadata yields qualityScore 0 (unknown ≠ assumed-good). The small 0.15
//     weight bounds the downside, and the catalog is vote-count gated so this rarely fires.

import { type Candidate, type ContentRow } from '@/lib/types/content'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { type TasteSeed } from '@/lib/types/taste'
import { categoriesOf, NEUTRAL_AFFINITY } from '@/lib/onboarding/categories'

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** The four composite-score weights. Always sum to 1; logged inside every scoreBreakdown so a row is
 *  self-describing and the category-affinity lift is measurable after the fact. */
export type ScoreWeights = {
  vectorSimilarity: number
  personalization: number
  categoryAffinity: number
  qualityScore: number
}

/**
 * Default weights (per the review). vectorSimilarity stays DOMINANT so an explicit query is always the
 * primary signal; categoryAffinity is the onboarding taste prior; personalization is per-title taste
 * overlap; quality is the rating floor.
 *
 *   vectorSimilarity 0.50 · personalization 0.20 · categoryAffinity 0.15 · quality 0.15
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  vectorSimilarity: 0.5,
  personalization: 0.2,
  categoryAffinity: 0.15,
  qualityScore: 0.15,
}

/** Back-compat alias for callers/tests that referenced the old name. */
export const SCORE_WEIGHTS = DEFAULT_SCORE_WEIGHTS

// The non-affinity weights are fixed; the categoryAffinity weight is the single tunable. Whatever it's
// set to (or 0 when disabled) is absorbed by vectorSimilarity so the four always sum to 1 — no caller
// has to keep them balanced.
const FIXED_PERSONALIZATION_WEIGHT = 0.2
const FIXED_QUALITY_WEIGHT = 0.15
const VECTOR_PLUS_AFFINITY_BUDGET = 1 - FIXED_PERSONALIZATION_WEIGHT - FIXED_QUALITY_WEIGHT // 0.65
/** Upper bound on the tunable so a misconfig can't starve the query signal. */
const MAX_CATEGORY_AFFINITY_WEIGHT = 0.4
/** Default tunable value (env-overridable, see getCategoryAffinityWeight). */
export const DEFAULT_CATEGORY_AFFINITY_WEIGHT = 0.15

/**
 * Builds a valid ScoreWeights from the single tunable. `categoryAffinityWeight` ≤ 0 (e.g. when the
 * `category_affinity` flag is OFF) collapses to the pre-personalization behaviour: the affinity factor
 * contributes nothing and its budget returns to vectorSimilarity. Always sums to 1.
 */
export function buildScoreWeights(categoryAffinityWeight: number): ScoreWeights {
  const affinity = clamp(categoryAffinityWeight, 0, MAX_CATEGORY_AFFINITY_WEIGHT)
  return {
    vectorSimilarity: VECTOR_PLUS_AFFINITY_BUDGET - affinity,
    personalization: FIXED_PERSONALIZATION_WEIGHT,
    categoryAffinity: affinity,
    qualityScore: FIXED_QUALITY_WEIGHT,
  }
}

/**
 * Resolves the tunable affinity weight from the environment (so it can be tweaked without a deploy of the
 * scorer). Pure (env injected) for testability. Defaults to DEFAULT_CATEGORY_AFFINITY_WEIGHT; clamped.
 */
export function getCategoryAffinityWeight(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SCORE_CATEGORY_AFFINITY_WEIGHT
  if (raw == null) return DEFAULT_CATEGORY_AFFINITY_WEIGHT
  const n = Number(raw)
  return Number.isFinite(n) ? clamp(n, 0, MAX_CATEGORY_AFFINITY_WEIGHT) : DEFAULT_CATEGORY_AFFINITY_WEIGHT
}

/** Personalization is centered here so a candidate with no taste signal is neither helped nor hurt. */
export const PERSONALIZATION_NEUTRAL = 0.5
/** Max metadata overlap with a loved seed lifts personalization from neutral to ~1.0. */
const LOVED_BOOST = 0.5
/** Liked seeds count for half a loved seed. */
const LIKED_BOOST = 0.25
/** Max metadata overlap with a disliked seed drops personalization from neutral to ~0.0. */
const DISLIKE_PENALTY = 0.5

/**
 * Vote count at which vote confidence reaches ~1.0 under log10 scaling: voteConfidence =
 * log10(votes + 1) / log10(VOTE_SATURATION), so at VOTE_SATURATION votes the discount lifts to
 * ~1.0 and a rating is trusted at face value; far fewer votes scales it down. log10(5000) ≈ 3.7.
 */
const VOTE_SATURATION = 5_000

/**
 * Cosine-similarity floor below which a match is "low confidence". voyage-3-lite query↔document
 * similarity runs ~0.3–0.8, but genuinely on-topic matches sit ~0.55+; the 0.4–0.55 band is mostly
 * loose thematic drift. 0.55 keeps the confidence signal meaningful rather than near-always 'high'.
 */
export const SIMILARITY_FLOOR = 0.55

// ─── Errors ───────────────────────────────────────────────────────────────────

export type ScoringErrorCode = 'INVALID_INPUT'

export class ScoringError extends Error {
  readonly code: ScoringErrorCode
  constructor(code: ScoringErrorCode, message: string) {
    super(message)
    this.name = 'ScoringError'
    this.code = code
  }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

export type ScoreBreakdown = {
  vectorSimilarity: number
  personalization: number
  /** Onboarding category-affinity prior in [0,1] (0.5 neutral). */
  categoryAffinity: number
  qualityScore: number
  /** The exact weights applied — logged so a row is self-explaining and the affinity lift is measurable. */
  weights: ScoreWeights
}

export type Confidence = 'high' | 'low'

export type ScoredCandidate = {
  content: ContentRow
  /** Final composite score in [0, 1]. */
  score: number
  /** Derived from the similarity floor — 'low' means the query matched this title weakly. */
  confidence: Confidence
  scoreBreakdown: ScoreBreakdown
}

export type ScoringInput = {
  candidates: Candidate[]
  /** The user's onboarding ratings. Empty = no personalization (all candidates score neutral on that factor). */
  tasteSeeds?: TasteSeed[]
  /** Per-category taste prior (category id → 0..1). Absent/empty ⇒ every candidate scores neutral here. */
  categoryAffinities?: Map<string, number>
  /** Weights to apply. Defaults to DEFAULT_SCORE_WEIGHTS; the engine passes flag/config-resolved weights so
   *  the categoryAffinity weight is tunable without a code change. */
  weights?: ScoreWeights
}

export type ScoringDeps = {
  logger?: Logger
}

// ─── Factor functions (pure, individually testable) ───────────────────────────

/**
 * Jaccard overlap of two titles' descriptive tags (genres ∪ mood ∪ theme), case-insensitive.
 * Returns 0 when either side has no tags — absent metadata reads as "no evidence", not similarity.
 * By design this means a title with an empty tag set contributes zero personalization (it can
 * neither be boosted toward nor penalized against any taste seed).
 */
export function tagOverlap(a: ContentRow, b: ContentRow): number {
  const setA = tagSet(a)
  const setB = tagSet(b)
  if (setA.size === 0 || setB.size === 0) return 0

  let intersection = 0
  for (const tag of setA) {
    if (setB.has(tag)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Personalization factor in [0, 1], centered at PERSONALIZATION_NEUTRAL.
 *
 * Each sentiment group accumulates a damped, saturating signal: every overlapping seed adds
 * `overlap × 0.65` to its group, clamped to 1.0. We moved away from pure `Math.max` because max
 * threw away corroborating evidence — five loved titles that each overlap the candidate scored
 * identically to one. Damped accumulation lets multiple weak-but-consistent seeds compound toward
 * a stronger signal, while the 0.65 factor + per-group clamp keep any single seed from saturating
 * the group and stop the sum from running away. Loved/liked lift the score, disliked lowers it;
 * the result is clamped to [0, 1].
 */
export function computePersonalization(candidate: ContentRow, seeds: TasteSeed[]): number {
  if (seeds.length === 0) return PERSONALIZATION_NEUTRAL

  let loved = 0
  let liked = 0
  let disliked = 0
  for (const seed of seeds) {
    const overlap = tagOverlap(candidate, seed.content)
    if (seed.sentiment === 'loved') loved = Math.min(1, loved + overlap * 0.65)
    else if (seed.sentiment === 'liked') liked = Math.min(1, liked + overlap * 0.65)
    else disliked = Math.min(1, disliked + overlap * 0.65)
  }

  const affinity = LOVED_BOOST * loved + LIKED_BOOST * liked
  const aversion = DISLIKE_PENALTY * disliked
  return clamp01(PERSONALIZATION_NEUTRAL + affinity - aversion)
}

/**
 * Quality factor in [0, 1].
 *
 * Prefers the precomputed BLENDED rating (a 0–100 weighted blend of IMDb 0.45 / Metacritic 0.35 /
 * TMDb 0.20 — see lib/sync/blended-rating.ts), normalized to [0,1]. It's a more credible quality
 * signal than any single source and already combines multiple sources, so no extra vote discount is
 * applied to it.
 *
 * FALLBACK (until the blend enrichment job has run, or a title has no blended_rating): the TMDb rating
 * (falling back to IMDb), scaled to [0,1] and discounted by log-scaled vote confidence so a high score
 * from few votes is trusted less. With no rating at all the factor is 0 (quality unknown, not assumed).
 */
export function computeQualityScore(content: ContentRow): number {
  if (content.blendedRating != null) {
    return clamp01(content.blendedRating / 100)
  }

  const rating = content.tmdbRating ?? content.imdbRating
  if (rating === null || rating === undefined) return 0

  const ratingNorm = clamp01(rating / 10)
  const votes = content.tmdbVoteCount ?? 0
  const voteConfidence = clamp01(Math.log10(votes + 1) / Math.log10(VOTE_SATURATION))
  return ratingNorm * voteConfidence
}

/**
 * Category-affinity factor in [0,1] for one candidate: the mean of the user's affinities across the
 * categories this title belongs to (genres → categories via the registry). NEUTRAL when the title is in
 * no known category, or the user has no signal there — so an uncategorized or untasted title is never
 * penalized, only left un-boosted. This is the onboarding swipe signal made auditable per result.
 */
export function computeCategoryAffinity(content: ContentRow, affinities?: Map<string, number>): number {
  if (!affinities || affinities.size === 0) return NEUTRAL_AFFINITY
  const cats = categoriesOf(content)
  if (cats.length === 0) return NEUTRAL_AFFINITY
  let sum = 0
  let n = 0
  for (const c of cats) {
    const a = affinities.get(c)
    if (a !== undefined) {
      sum += a
      n++
    }
  }
  return n === 0 ? NEUTRAL_AFFINITY : sum / n
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Scores every candidate with the composite formula and returns them sorted by descending score.
 * Pure and synchronous — no I/O. Ties broken by raw vectorSimilarity (the most trustworthy signal).
 *
 * @throws ScoringError('INVALID_INPUT') if candidates is not an array.
 */
export function scoreAndRank(input: ScoringInput, deps: ScoringDeps = {}): ScoredCandidate[] {
  const logger = deps.logger ?? noopLogger
  if (!Array.isArray(input.candidates)) {
    throw new ScoringError('INVALID_INPUT', 'candidates must be an array')
  }
  // null/undefined both mean "no seeds" (consistent with the ?? below); only a present, non-array value is invalid.
  if (input.tasteSeeds != null && !Array.isArray(input.tasteSeeds)) {
    throw new ScoringError('INVALID_INPUT', 'tasteSeeds must be an array when provided')
  }
  const seeds = input.tasteSeeds ?? []
  const affinities = input.categoryAffinities
  const weights = input.weights ?? DEFAULT_SCORE_WEIGHTS

  const scored: ScoredCandidate[] = input.candidates.map((candidate) => {
    const vectorSimilarity = clamp01(candidate.vectorSimilarity)
    const personalization = computePersonalization(candidate.content, seeds)
    const categoryAffinity = computeCategoryAffinity(candidate.content, affinities)
    const qualityScore = computeQualityScore(candidate.content)

    const score =
      vectorSimilarity * weights.vectorSimilarity +
      personalization * weights.personalization +
      categoryAffinity * weights.categoryAffinity +
      qualityScore * weights.qualityScore

    return {
      content: candidate.content,
      score,
      confidence: candidate.vectorSimilarity >= SIMILARITY_FLOOR ? 'high' : 'low',
      scoreBreakdown: {
        vectorSimilarity,
        personalization,
        categoryAffinity,
        qualityScore,
        weights,
      },
    }
  })

  scored.sort((a, b) => b.score - a.score || b.scoreBreakdown.vectorSimilarity - a.scoreBreakdown.vectorSimilarity)

  logger.info('scoring complete', {
    scored: scored.length,
    seeds: seeds.length,
    topScore: scored[0]?.score ?? null,
    lowConfidence: scored.filter((s) => s.confidence === 'low').length,
  })

  return scored
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function tagSet(content: ContentRow): Set<string> {
  const set = new Set<string>()
  for (const tag of [...content.genres, ...content.moodTags, ...content.themeTags]) {
    const normalized = tag.trim().toLowerCase()
    if (normalized) set.add(normalized)
  }
  return set
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
