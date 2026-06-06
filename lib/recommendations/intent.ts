// Intent parsing — step 0 of the recommendation pipeline (Phase 1 negatives + Phase 2 positives).
//
// Extracts confident structured constraints from a free-text query against controlled vocabularies and
// returns a cleaned query string for embedding. Two reasons this matters:
//   1. Embeddings handle negation/metadata poorly — "no horror" or "on netflix" pollute the vector.
//      Stripping recognized constraint clauses leaves a cleaner semantic query to embed.
//   2. The extracted constraints map to hard filters we already own (platform, type, runtime, language).
//
// Design:
//   • Pure, synchronous, dependency-free — trivially unit-testable, zero latency, no LLM (later phase).
//   • A single token scan tries ordered matchers; the first that matches at a position consumes its
//     tokens (and marks them for stripping). Negation is matched first so "not on netflix" reads as an
//     exclusion, not a positive platform.
//   • FAIL-OPEN: we only act on a controlled-vocabulary match in the expected shape (e.g. a runtime
//     needs a comparator + number + unit; a positive platform needs a locator + known platform). Any
//     phrase we can't confidently map is left in the query and embedded as before.
//   • Genre/platform aliases resolve to ALL matching canonical values (catalog mixes movie + TV).

export type ParsedIntent = {
  /** Query with confidently-recognized constraint clauses removed; safe to embed. */
  cleanedQuery: string
  // ── Negative constraints ──
  excludePlatforms: string[]
  excludeGenres: string[]
  // ── Positive constraints ──
  includePlatforms: string[]
  /** 'movie' | 'series' when the user asked for one; undefined if unspecified or ambiguous. */
  contentType?: 'movie' | 'series'
  /** Upper runtime bound in minutes (movies by runtime, series by avg episode length). */
  maxRuntimeMinutes?: number
  /** ISO 639-1 language code (e.g. 'en') the user asked for. */
  originalLanguage?: string
}

/** The three platforms we carry. Exported so the engine can build a negation/positive allow-set. */
export const PLATFORM_SLUGS = ['netflix', 'prime', 'disney'] as const

const PLATFORM_ALIASES: Record<string, string> = {
  netflix: 'netflix',
  nflx: 'netflix',
  prime: 'prime',
  'prime video': 'prime',
  amazon: 'prime',
  'amazon prime': 'prime',
  'amazon prime video': 'prime',
  disney: 'disney',
  'disney+': 'disney',
  disneyplus: 'disney',
  'disney plus': 'disney',
}

const GENRE_ALIASES: Record<string, string[]> = {
  action: ['Action', 'Action & Adventure'],
  adventure: ['Adventure', 'Action & Adventure'],
  'action & adventure': ['Action & Adventure'],
  animation: ['Animation'],
  animated: ['Animation'],
  cartoon: ['Animation'],
  comedy: ['Comedy'],
  comedies: ['Comedy'],
  crime: ['Crime'],
  documentary: ['Documentary'],
  documentaries: ['Documentary'],
  docs: ['Documentary'],
  drama: ['Drama'],
  dramas: ['Drama'],
  family: ['Family'],
  kids: ['Kids', 'Family'],
  children: ['Family', 'Kids'],
  fantasy: ['Fantasy', 'Sci-Fi & Fantasy'],
  history: ['History'],
  historical: ['History'],
  horror: ['Horror'],
  scary: ['Horror'],
  music: ['Music'],
  musical: ['Music'],
  musicals: ['Music'],
  mystery: ['Mystery'],
  romance: ['Romance'],
  romantic: ['Romance'],
  'rom-com': ['Romance'],
  romcom: ['Romance'],
  'sci-fi': ['Science Fiction', 'Sci-Fi & Fantasy'],
  scifi: ['Science Fiction', 'Sci-Fi & Fantasy'],
  'sci fi': ['Science Fiction', 'Sci-Fi & Fantasy'],
  'science fiction': ['Science Fiction', 'Sci-Fi & Fantasy'],
  'sci-fi & fantasy': ['Sci-Fi & Fantasy'],
  thriller: ['Thriller'],
  thrillers: ['Thriller'],
  war: ['War', 'War & Politics'],
  'war & politics': ['War & Politics'],
  western: ['Western'],
  westerns: ['Western'],
  reality: ['Reality'],
}

// Common language names → ISO 639-1 codes (content.original_language stores codes like 'en','de').
const LANGUAGES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  japanese: 'ja',
  korean: 'ko',
  mandarin: 'zh',
  chinese: 'zh',
  cantonese: 'zh',
  hindi: 'hi',
  russian: 'ru',
  arabic: 'ar',
  dutch: 'nl',
  swedish: 'sv',
  danish: 'da',
  norwegian: 'no',
  turkish: 'tr',
  polish: 'pl',
}

// Negation cues.
const SINGLE_CUES = new Set(['not', 'no', 'without', 'except', 'excluding', 'exclude', 'minus', 'sans'])
const DOUBLE_CUES: [string, string][] = [
  ['anything', 'but'],
  ['nothing', 'with'],
  ['nothing', 'featuring'],
  ['no', 'more'],
]
const FILLERS = new Set(['on', 'from', 'the', 'a', 'an', 'any', 'of', 'to', 'available', 'more'])

// Runtime comparators (word arrays, longest checked first), units, and content-type nouns.
const RUNTIME_COMPARATORS: string[][] = [
  ['no', 'longer', 'than'],
  ['no', 'more', 'than'],
  ['less', 'than'],
  ['shorter', 'than'],
  ['at', 'most'],
  ['under'],
  ['below'],
  ['max'],
]
const HOUR_UNITS = new Set(['hour', 'hours', 'hr', 'hrs'])
const MINUTE_UNITS = new Set(['minute', 'minutes', 'min', 'mins'])

const MOVIE_NOUNS = new Set(['movie', 'movies', 'film', 'films'])
const SERIES_NOUNS = new Set(['series', 'shows', 'tv']) // note: bare "show" excluded ("show me ...")
const TYPE_QUANTIFIERS = new Set(['only', 'just', 'all'])
const PLATFORM_LOCATORS = new Set(['on', 'from'])
const TWO_WORD_LOCATORS: string[][] = [
  ['streaming', 'on'],
  ['available', 'on'],
  ['watch', 'on'],
]

type VocabEntry =
  | { words: string[]; kind: 'platform'; slug: string }
  | { words: string[]; kind: 'genre'; genres: string[] }

const VOCAB: VocabEntry[] = [
  ...Object.entries(PLATFORM_ALIASES).map(
    ([alias, slug]): VocabEntry => ({ words: alias.split(' '), kind: 'platform', slug })
  ),
  ...Object.entries(GENRE_ALIASES).map(
    ([alias, genres]): VocabEntry => ({ words: alias.split(' '), kind: 'genre', genres })
  ),
].sort((a, b) => b.words.length - a.words.length)

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^a-z0-9&+-]+/, '')
    .replace(/[^a-z0-9&+-]+$/, '')
}

function seqEquals(norm: string[], at: number, words: string[]): boolean {
  if (at + words.length > norm.length) return false
  for (let k = 0; k < words.length; k++) if (norm[at + k] !== words[k]) return false
  return true
}

function matchVocab(norm: string[], at: number, kind?: 'platform' | 'genre'): { len: number; entry: VocabEntry } | null {
  for (const entry of VOCAB) {
    if (kind && entry.kind !== kind) continue
    if (seqEquals(norm, at, entry.words)) return { len: entry.words.length, entry }
  }
  return null
}

function matchCueLength(norm: string[], i: number): number {
  for (const [a, b] of DOUBLE_CUES) if (norm[i] === a && norm[i + 1] === b) return 2
  return SINGLE_CUES.has(norm[i]) ? 1 : 0
}

// ── Matchers: each returns the exclusive end index of the consumed span, plus its effect. ──

type Draft = {
  excludePlatforms: Set<string>
  excludeGenres: Set<string>
  includePlatforms: Set<string>
  typeVotes: Set<'movie' | 'series'>
  maxRuntimeMinutes?: number
  originalLanguage?: string
}

function tryNegation(norm: string[], i: number, draft: Draft): number | null {
  const cueLen = matchCueLength(norm, i)
  if (cueLen === 0) return null
  let j = i + cueLen
  while (j < norm.length && FILLERS.has(norm[j])) j++
  const match = matchVocab(norm, j)
  if (!match) return null
  if (match.entry.kind === 'platform') draft.excludePlatforms.add(match.entry.slug)
  else for (const g of match.entry.genres) draft.excludeGenres.add(g)
  return j + match.len
}

function tryRuntime(norm: string[], i: number, draft: Draft): number | null {
  let compLen = 0
  for (const comp of RUNTIME_COMPARATORS) {
    if (seqEquals(norm, i, comp)) {
      compLen = comp.length
      break
    }
  }
  if (compLen === 0) return null
  const countTok = norm[i + compLen]
  const unitTok = norm[i + compLen + 1]
  if (countTok == null || unitTok == null) return null
  const count = countTok === 'a' || countTok === 'an' ? 1 : Number(countTok)
  if (!Number.isFinite(count) || count <= 0) return null
  const mult = HOUR_UNITS.has(unitTok) ? 60 : MINUTE_UNITS.has(unitTok) ? 1 : 0
  if (mult === 0) return null
  const minutes = Math.round(count * mult)
  draft.maxRuntimeMinutes = draft.maxRuntimeMinutes == null ? minutes : Math.min(draft.maxRuntimeMinutes, minutes)
  return i + compLen + 2
}

function tryLanguage(norm: string[], i: number, draft: Draft): number | null {
  if (norm[i] !== 'in') return null
  const code = LANGUAGES[norm[i + 1]]
  if (!code) return null
  if (!draft.originalLanguage) draft.originalLanguage = code
  return i + 2
}

function tryPositivePlatform(norm: string[], i: number, draft: Draft): number | null {
  // "streaming on netflix" / "available on disney" / "watch on prime"
  for (const loc of TWO_WORD_LOCATORS) {
    if (seqEquals(norm, i, loc)) {
      const plat = matchVocab(norm, i + loc.length, 'platform')
      if (plat && plat.entry.kind === 'platform') {
        draft.includePlatforms.add(plat.entry.slug)
        return i + loc.length + plat.len
      }
    }
  }
  // "on netflix" / "from disney" (optionally past "the")
  if (PLATFORM_LOCATORS.has(norm[i])) {
    let j = i + 1
    if (norm[j] === 'the') j++
    const plat = matchVocab(norm, j, 'platform')
    if (plat && plat.entry.kind === 'platform') {
      draft.includePlatforms.add(plat.entry.slug)
      return j + plat.len
    }
  }
  // "only netflix" / "just on disney"
  if (norm[i] === 'only' || norm[i] === 'just') {
    let j = i + 1
    if (PLATFORM_LOCATORS.has(norm[j])) j++
    if (norm[j] === 'the') j++
    const plat = matchVocab(norm, j, 'platform')
    if (plat && plat.entry.kind === 'platform') {
      draft.includePlatforms.add(plat.entry.slug)
      return j + plat.len
    }
  }
  return null
}

function matchTypeNoun(norm: string[], at: number): { type: 'movie' | 'series'; len: number } | null {
  if (norm[at] === 'tv' && (norm[at + 1] === 'show' || norm[at + 1] === 'shows' || norm[at + 1] === 'series')) {
    return { type: 'series', len: 2 }
  }
  if (MOVIE_NOUNS.has(norm[at])) return { type: 'movie', len: 1 }
  if (SERIES_NOUNS.has(norm[at])) return { type: 'series', len: 1 }
  return null
}

function tryContentType(norm: string[], i: number, draft: Draft): number | null {
  // "only movies" / "just tv shows"
  if (TYPE_QUANTIFIERS.has(norm[i])) {
    const tn = matchTypeNoun(norm, i + 1)
    if (tn) {
      draft.typeVotes.add(tn.type)
      return i + 1 + tn.len
    }
  }
  // bare "movies" / "series", optionally "movies only"
  const tn = matchTypeNoun(norm, i)
  if (tn) {
    draft.typeVotes.add(tn.type)
    const after = i + tn.len
    return norm[after] === 'only' ? after + 1 : after
  }
  return null
}

/**
 * Parses structured constraints (negative + positive) out of a free-text query.
 *
 * @returns the cleaned (constraint-stripped) query plus deduped exclusions/inclusions. Content type is
 *          left undefined when ambiguous (both "movies" and "shows" mentioned). If the whole query was
 *          constraints, cleanedQuery is '' and the engine falls back to the raw text for embedding.
 */
export function parseQueryConstraints(queryText: string): ParsedIntent {
  const raw = (queryText ?? '').trim()
  if (!raw) {
    return { cleanedQuery: '', excludePlatforms: [], excludeGenres: [], includePlatforms: [] }
  }

  const original = raw.split(/\s+/)
  const norm = original.map(normalizeToken)
  const remove = new Array<boolean>(original.length).fill(false)
  const draft: Draft = {
    excludePlatforms: new Set(),
    excludeGenres: new Set(),
    includePlatforms: new Set(),
    typeVotes: new Set(),
  }

  let i = 0
  while (i < norm.length) {
    // Negation first so "not on netflix" is an exclusion, not a positive platform.
    const end =
      tryNegation(norm, i, draft) ??
      tryRuntime(norm, i, draft) ??
      tryLanguage(norm, i, draft) ??
      tryPositivePlatform(norm, i, draft) ??
      tryContentType(norm, i, draft)
    if (end != null) {
      for (let k = i; k < end; k++) remove[k] = true
      i = end
      continue
    }
    i++
  }

  const cleanedQuery = original
    .filter((_, idx) => !remove[idx])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Content type only applies when unambiguous (exactly one type mentioned).
  const contentType = draft.typeVotes.size === 1 ? [...draft.typeVotes][0] : undefined

  return {
    cleanedQuery,
    excludePlatforms: [...draft.excludePlatforms],
    excludeGenres: [...draft.excludeGenres],
    includePlatforms: [...draft.includePlatforms],
    ...(contentType ? { contentType } : {}),
    ...(draft.maxRuntimeMinutes != null ? { maxRuntimeMinutes: draft.maxRuntimeMinutes } : {}),
    ...(draft.originalLanguage ? { originalLanguage: draft.originalLanguage } : {}),
  }
}
