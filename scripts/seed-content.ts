// scripts/seed-content.ts — One-time content ingestion pipeline.
//
// Fetches high-quality streaming titles from TMDb, cross-checks availability
// on Netflix / Prime Video / Disney+ (US), enriches with full metadata,
// derives mood/theme tags, builds embedding inputs, and writes to Supabase.
//
// Run:
//   npx tsx --env-file=.env.local scripts/seed-content.ts
//
// Safe to re-run — all writes are upserts. Existing embeddings are preserved.
//
// To extend:
//   - Add genres to DISCOVER_MOVIE_GENRES / DISCOVER_TV_GENRES
//   - Increase LIST_PAGES or DISCOVER_PAGES for more candidates
//   - Edit tag_mappings rows in Supabase to improve tagging (no code change needed)
//   - Change MIN_VOTE_COUNT to include more niche or recent titles

// Force IPv4 DNS resolution — fixes ECONNRESET on Windows where Node.js
// prefers IPv6 but the remote host drops those connections.
import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import axios from 'axios'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Supabase client typed loosely — we haven't generated schema types yet.
// Once `supabase gen types` is run, replace with the generated Database type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>
import { createTMDbClient } from '../lib/sync/tmdb-client'
import { createStreamingApiClient } from '../lib/sync/streaming-api-client'
import {
  loadTagMappings,
  applyTagMappings,
  SEED_TAG_MAPPINGS,
} from '../lib/sync/keyword-mapper'
import type {
  TMDbCandidate,
  AvailableCandidate,
  EnrichedContent,
  TaggedContent,
  TagMapping,
  SyncJobMetadata,
  SkipReason,
} from '../lib/types/sync'

// ─── Configuration ────────────────────────────────────────────────────────────
// To extend the catalog: increase these values or add genre IDs below.

const MIN_VOTE_COUNT = 150
const BATCH_SIZE = 50          // Supabase upsert batch size
const LIST_PAGES = 12          // Pages from popular/top_rated lists (20 results each)
const DISCOVER_PAGES = 8       // Pages from discover endpoint per genre

// Seed profile. 'broad' = original behavior; 'targeted' = TV + adult genres on Netflix/Prime.
// Set via env: SEED_MODE=targeted npm run seed
const SEED_MODE = (process.env.SEED_MODE ?? 'broad').toLowerCase()

// TMDb genre IDs — find IDs at https://api.themoviedb.org/3/genre/movie/list?api_key=YOUR_KEY
const DISCOVER_MOVIE_GENRES = [35, 878, 27, 53, 10751] // Comedy, Sci-Fi, Horror, Thriller, Family
const DISCOVER_TV_GENRES    = [35, 10765, 10751, 80]    // Comedy, Sci-Fi & Fantasy, Family, Crime

// ── Targeted-mode config (SEED_MODE=targeted) ────────────────────────────────
// Goal: correct the movie-only, animation-heavy catalog by favoring live-action
// SERIES and adult genres (drama/crime/thriller/mystery) that are on Netflix/Prime.
//
// Technique: TMDb Discover with `with_watch_providers` + `watch_region=US`. This
// returns only titles TMDb knows are on those providers, which (a) sharply raises the
// streaming-availability hit-rate and (b) biases away from the Disney+/animation cluster.
// `without_genres` excludes Animation(16) + Family(10751) to stop re-adding the bias.

const TMDB_PROVIDERS = { netflix: 8, prime: 9, disney: 337 } as const
const NETFLIX_PRIME = `${TMDB_PROVIDERS.netflix}|${TMDB_PROVIDERS.prime}` // '8|9'
const EXCLUDE_GENRES = '16,10751' // Animation, Family

// Adult-leaning genres. TV and movie share these IDs.
const TARGETED_TV_GENRES    = [18, 80, 9648, 10765] // Drama, Crime, Mystery, Sci-Fi & Fantasy
const TARGETED_MOVIE_GENRES = [18, 80, 53, 9648]    // Drama, Crime, Thriller, Mystery
const TARGETED_TV_PAGES    = 8
const TARGETED_MOVIE_PAGES = 4 // fewer movie pages — we already have plenty of movies

function targetedDiscoverParams(genreId: number): Record<string, string | number> {
  return {
    with_genres: genreId,
    without_genres: EXCLUDE_GENRES,
    with_watch_providers: NETFLIX_PRIME,
    watch_region: 'US',
    with_original_language: 'en',
    sort_by: 'vote_average.desc',
    'vote_count.gte': MIN_VOTE_COUNT,
  }
}

/** Counts candidates by content type — the core observability primitive. */
function countByType(candidates: { type: 'movie' | 'series' }[]): { movie: number; series: number } {
  return candidates.reduce(
    (acc, c) => { acc[c.type]++; return acc },
    { movie: 0, series: 0 }
  )
}

// ─── Environment Validation ───────────────────────────────────────────────────

function validateEnv(): void {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TMDB_API_KEY',
    'STREAMING_API_KEY',
    'STREAMING_API_BASE_URL',
  ]
  const missing = required.filter(key => !process.env[key])
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:')
    missing.forEach(k => console.error(`   ${k}`))
    console.error('\n   Run with: npx tsx --env-file=.env.local scripts/seed-content.ts\n')
    process.exit(1)
  }
}

// ─── Logging Helpers ──────────────────────────────────────────────────────────

function log(msg: string) { console.log(msg) }
function logOk(msg: string) { console.log(`  ✓ ${msg}`) }
function logInfo(msg: string) { console.log(`  ℹ  ${msg}`) }
function logWarn(msg: string) { console.log(`  ⚠  ${msg}`) }
function logErr(msg: string) { console.error(`  ✗ ${msg}`) }

// ─── Phase 0: Setup ───────────────────────────────────────────────────────────

async function setup(): Promise<{ supabase: AnySupabaseClient; syncJobId: string }> {
  validateEnv()

  // Service role key bypasses RLS — only used server-side in sync scripts, never in the browser
  const supabase: AnySupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Verify DB connection
  const { error: pingErr } = await supabase.from('platforms').select('id').limit(1)
  if (pingErr) {
    logErr(`Cannot connect to Supabase: ${pingErr.message}`)
    process.exit(1)
  }
  logOk('Supabase connection: OK')

  // Verify TMDb key using axios (avoids undici/fetch SSL issues on Windows)
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/configuration?api_key=${process.env.TMDB_API_KEY!}`,
      { timeout: 15_000 }
    )
    if (res.status !== 200) {
      logErr(`TMDb API key invalid (HTTP ${res.status})`)
      process.exit(1)
    }
  } catch (err) {
    logErr(`TMDb API unreachable: ${err instanceof Error ? err.message : String(err)}`)
    logErr('Check your internet connection and that TMDB_API_KEY is correct')
    process.exit(1)
  }
  logOk('TMDb API: OK')

  // Verify Streaming API key
  try {
    const res = await axios.get(
      `${process.env.STREAMING_API_BASE_URL!}/v4/shows/movie/603?country=us`,
      {
        headers: { 'x-api-key': process.env.STREAMING_API_KEY! },
        timeout: 15_000,
        validateStatus: () => true,
      }
    )
    if (res.status === 401 || res.status === 403) {
      logErr(`Streaming API key invalid (HTTP ${res.status})`)
      process.exit(1)
    }
  } catch (err) {
    logErr(`Streaming API unreachable: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  logOk('Streaming API: OK')

  // Seed tag_mappings if empty
  const { count } = await supabase
    .from('tag_mappings')
    .select('*', { count: 'exact', head: true })

  if (count === 0) {
    const { error: seedErr } = await supabase.from('tag_mappings').insert(SEED_TAG_MAPPINGS)
    if (seedErr) {
      logErr(`Failed to seed tag_mappings: ${seedErr.message}`)
      process.exit(1)
    }
    logOk(`Tag mappings: seeded ${SEED_TAG_MAPPINGS.length} mappings`)
  } else {
    logOk(`Tag mappings: ${count} existing mappings loaded (skipped re-seed)`)
  }

  // Create sync job record
  const { data: job, error: jobErr } = await supabase
    .from('sync_jobs')
    .insert({ job_type: 'tmdb_seed', status: 'running', started_at: new Date().toISOString() })
    .select('id')
    .single()

  if (jobErr || !job) {
    logErr(`Failed to create sync_jobs record: ${jobErr?.message}`)
    process.exit(1)
  }
  logOk(`Sync job created: ${job.id}`)

  return { supabase, syncJobId: job.id as string }
}

// ─── Phase 1: Fetch TMDb Candidates ──────────────────────────────────────────

async function fetchCandidates(tmdb: ReturnType<typeof createTMDbClient>): Promise<{
  candidates: TMDbCandidate[]
  rawFetched: number
}> {
  const start = Date.now()
  log(`\n[Phase 1] Fetching TMDb candidates... (mode: ${SEED_MODE})`)

  const allRaw: TMDbCandidate[] = []

  if (SEED_MODE === 'targeted') {
    // TV-first, adult genres, Netflix/Prime only, animation/family excluded.
    for (const genreId of TARGETED_TV_GENRES) {
      allRaw.push(...await tmdb.discover('series', TARGETED_TV_PAGES, targetedDiscoverParams(genreId)))
    }
    for (const genreId of TARGETED_MOVIE_GENRES) {
      allRaw.push(...await tmdb.discover('movie', TARGETED_MOVIE_PAGES, targetedDiscoverParams(genreId)))
    }
    // Prestige TV from the curated lists too — these are the "I loved Succession" titles.
    allRaw.push(...await tmdb.getTopRatedTV(LIST_PAGES))
    allRaw.push(...await tmdb.getPopularTV(LIST_PAGES))
  } else {
    // Broad profile (original behavior).
    allRaw.push(...await tmdb.getPopularMovies(LIST_PAGES))
    allRaw.push(...await tmdb.getTopRatedMovies(LIST_PAGES))
    allRaw.push(...await tmdb.getPopularTV(LIST_PAGES))
    allRaw.push(...await tmdb.getTopRatedTV(LIST_PAGES))
    for (const genreId of DISCOVER_MOVIE_GENRES) {
      allRaw.push(...await tmdb.discoverMoviesByGenre(genreId, DISCOVER_PAGES))
    }
    for (const genreId of DISCOVER_TV_GENRES) {
      allRaw.push(...await tmdb.discoverTVByGenre(genreId, DISCOVER_PAGES))
    }
  }

  const rawFetched = allRaw.length

  // Deduplicate by tmdbId (lists overlap heavily)
  const seen = new Set<number>()
  const unique: TMDbCandidate[] = []
  for (const c of allRaw) {
    if (!seen.has(c.tmdbId)) {
      seen.add(c.tmdbId)
      unique.push(c)
    }
  }

  // Apply minimum vote filter
  const candidates = unique.filter(c => c.voteCount >= MIN_VOTE_COUNT)
  const byType = countByType(candidates)

  logOk(
    `${rawFetched.toLocaleString()} fetched → ` +
    `${unique.length.toLocaleString()} unique → ` +
    `${candidates.length.toLocaleString()} after vote filter (min: ${MIN_VOTE_COUNT})`
  )
  logInfo(`By type → movies: ${byType.movie}, series: ${byType.series}`)
  log(`  Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`)

  return { candidates, rawFetched }
}

// ─── Phase 2: Streaming Availability Check ────────────────────────────────────

async function checkAvailability(
  candidates: TMDbCandidate[],
  streamingClient: ReturnType<typeof createStreamingApiClient>
): Promise<{
  available: AvailableCandidate[]
  notAvailable: number
  apiErrors: number
  checkedByType: { movie: number; series: number }
  availableByType: { movie: number; series: number }
}> {
  const start = Date.now()
  log('\n[Phase 2] Checking streaming availability...')
  log(`  Checking ${candidates.length.toLocaleString()} titles against Netflix / Prime / Disney+ US`)
  log('  (This takes a few minutes)')

  // Progress ticker
  let checked = 0
  const progressInterval = setInterval(() => {
    process.stdout.write(`\r  Progress: ${checked}/${candidates.length}`)
  }, 2000)

  const CHUNK = 200
  const available: AvailableCandidate[] = []
  let apiErrors = 0

  // Process in chunks to surface progress and keep memory manageable
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const result = await streamingClient.checkBatch(chunk)
    available.push(...result.available)
    apiErrors += result.apiErrors
    checked += chunk.length
    // NOTE: The streaming API has daily rate limits on free keys.
    // Re-run this script on separate days to accumulate more titles.
  }

  clearInterval(progressInterval)
  process.stdout.write('\r')

  const notAvailable = candidates.length - available.length - apiErrors
  const checkedByType = countByType(candidates)
  const availableByType = countByType(available)

  logOk(
    `${available.length.toLocaleString()} / ${candidates.length.toLocaleString()} ` +
    `confirmed on target platforms`
  )
  logInfo(
    `Available by type → movies: ${availableByType.movie}/${checkedByType.movie}, ` +
    `series: ${availableByType.series}/${checkedByType.series}`
  )
  if (apiErrors > 0) logWarn(`${apiErrors} titles skipped due to API errors`)
  log(`  Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`)

  return { available, notAvailable, apiErrors, checkedByType, availableByType }
}

// ─── Phase 3: TMDb Enrichment ─────────────────────────────────────────────────

async function enrichContent(
  available: AvailableCandidate[],
  tmdb: ReturnType<typeof createTMDbClient>
): Promise<{
  enriched: EnrichedContent[]
  skippedMissingOverview: number
  skippedApiError: number
}> {
  const start = Date.now()
  log('\n[Phase 3] Enriching with full TMDb metadata...')
  log(`  Enriching ${available.length.toLocaleString()} titles`)

  const enriched: EnrichedContent[] = []
  let skippedMissingOverview = 0
  let skippedApiError = 0

  for (let i = 0; i < available.length; i++) {
    const candidate = available[i]
    if (i % 50 === 0) {
      process.stdout.write(`\r  Progress: ${i}/${available.length}`)
    }

    try {
      const result = candidate.type === 'movie'
        ? await tmdb.enrichMovie(candidate)
        : await tmdb.enrichTV(candidate)

      if (result === null) {
        skippedMissingOverview++
      } else {
        enriched.push(result)
      }
    } catch {
      skippedApiError++
    }
  }

  process.stdout.write('\r')

  logOk(
    `${enriched.length.toLocaleString()} / ${available.length.toLocaleString()} enriched` +
    (skippedMissingOverview > 0 ? ` (${skippedMissingOverview} missing overview)` : '') +
    (skippedApiError > 0 ? ` (${skippedApiError} API errors)` : '')
  )
  log(`  Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`)

  return { enriched, skippedMissingOverview, skippedApiError }
}

// ─── Phase 4: Tag Derivation + Embedding Input ────────────────────────────────

function buildEmbeddingInput(content: EnrichedContent, moodTags: string[], themeTags: string[]): string {
  const type = content.type === 'movie' ? 'movie' : 'series'
  const genres = content.genres.slice(0, 4).join(', ')
  const mood = moodTags.slice(0, 4).join(', ')
  const themes = themeTags.slice(0, 4).join(', ')
  const description = content.description.slice(0, 400).replace(/\s+/g, ' ').trim()
  const cast = content.castNames.slice(0, 5).join(', ')
  const keywords = content.tmdbKeywords.slice(0, 10).join(', ')

  return [
    `Title: ${content.title}.`,
    `Type: ${type}.`,
    content.releaseYear ? `Year: ${content.releaseYear}.` : '',
    genres ? `Genres: ${genres}.` : '',
    mood ? `Mood: ${mood}.` : '',
    themes ? `Themes: ${themes}.` : '',
    description ? `Description: ${description}.` : '',
    cast ? `Cast: ${cast}.` : '',
    keywords ? `Keywords: ${keywords}.` : '',
  ].filter(Boolean).join(' ')
}

async function deriveTagsAndBuildEmbeddingInput(
  enriched: EnrichedContent[],
  tagMappings: TagMapping[]
): Promise<{
  tagged: TaggedContent[]
  allUnmappedKeywords: string[]
}> {
  log('\n[Phase 4] Deriving tags and building embedding inputs...')

  const tagged: TaggedContent[] = []
  const unmappedAgg = new Map<string, number>()

  for (const content of enriched) {
    const { moodTags, themeTags, unmappedKeywords } = applyTagMappings(
      content.tmdbKeywords,
      content.genres,
      tagMappings
    )

    for (const kw of unmappedKeywords) {
      unmappedAgg.set(kw, (unmappedAgg.get(kw) ?? 0) + 1)
    }

    const embeddingInput = buildEmbeddingInput(content, moodTags, themeTags)

    tagged.push({ ...content, moodTags, themeTags, embeddingInput, unmappedKeywords })
  }

  // Surface the most-seen unmapped keywords — these are the best candidates for new tag_mappings rows
  const topUnmapped = [...unmappedAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw)

  logOk(`${tagged.length.toLocaleString()} titles tagged`)
  if (topUnmapped.length > 0) {
    logInfo(`Top unmapped keywords (consider adding to tag_mappings): ${topUnmapped.slice(0, 8).join(', ')}`)
  }

  return { tagged, allUnmappedKeywords: topUnmapped }
}

// ─── Phase 5: Write to Supabase ───────────────────────────────────────────────

async function writeToDatabase(
  tagged: TaggedContent[],
  supabase: AnySupabaseClient
): Promise<{ contentUpserted: number; platformsUpserted: number }> {
  const start = Date.now()
  log('\n[Phase 5] Writing to Supabase...')

  let contentUpserted = 0
  let platformsUpserted = 0

  // Platform slug → UUID lookup (platforms table was pre-seeded by migration 001)
  const { data: dbPlatforms, error: platErr } = await supabase
    .from('platforms')
    .select('id, slug')

  if (platErr || !dbPlatforms) throw new Error(`Failed to load platforms: ${platErr?.message}`)

  type DbPlatform = { id: string; slug: string }
  const platformIdBySlug = new Map(
    (dbPlatforms as DbPlatform[]).map(p => [p.slug, p.id])
  )

  // Write in batches to stay within Supabase request limits
  for (let i = 0; i < tagged.length; i += BATCH_SIZE) {
    const batch = tagged.slice(i, i + BATCH_SIZE)

    const contentRows = batch.map(c => ({
      tmdb_id: c.tmdbId,
      title: c.title,
      type: c.type,
      release_year: c.releaseYear,
      description: c.description,
      genres: c.genres,
      mood_tags: c.moodTags,
      theme_tags: c.themeTags,
      cast_names: c.castNames,
      director_names: c.directorNames,
      runtime_minutes: c.runtimeMinutes,
      avg_episode_minutes: c.avgEpisodeMinutes,
      season_count: c.seasonCount,
      tmdb_rating: c.tmdbRating,
      tmdb_vote_count: c.tmdbVoteCount,
      poster_url: c.posterUrl,
      backdrop_url: c.backdropUrl,
      content_rating: c.contentRating,
      original_language: c.originalLanguage,
      tmdb_keywords: c.tmdbKeywords,
      embedding_input: c.embeddingInput,
      // embedding is intentionally omitted — populated by Step 5 (Voyage AI)
      tmdb_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    type UpsertedRow = { id: string; tmdb_id: number }

    const { data: upsertedContent, error: contentErr } = await supabase
      .from('content')
      .upsert(contentRows, { onConflict: 'tmdb_id', ignoreDuplicates: false })
      .select('id, tmdb_id')

    if (contentErr) {
      logWarn(`Batch ${Math.floor(i / BATCH_SIZE) + 1} content upsert failed: ${contentErr.message}`)
      continue
    }

    const upsertedRows = (upsertedContent ?? []) as UpsertedRow[]
    contentUpserted += upsertedRows.length

    // Build content_id lookup for the just-upserted batch
    const contentIdByTmdbId = new Map(upsertedRows.map(row => [row.tmdb_id, row.id]))

    // Build platform availability rows (renamed to avoid shadowing dbPlatforms)
    const platformRecords: Record<string, unknown>[] = []
    for (const content of batch) {
      const contentId = contentIdByTmdbId.get(content.tmdbId)
      if (!contentId) continue

      for (const platform of content.platforms) {
        const platformId = platformIdBySlug.get(platform.platformSlug)
        if (!platformId) continue

        platformRecords.push({
          content_id: contentId,
          platform_id: platformId,
          region: 'us',
          deep_link: platform.deepLink,
          streaming_type: platform.streamingType,
          available_from: platform.availableFrom?.toISOString() ?? null,
          available_until: platform.availableUntil?.toISOString() ?? null,
          updated_at: new Date().toISOString(),
        })
      }
    }

    if (platformRecords.length > 0) {
      const { data: upsertedPlatforms, error: platUpsertErr } = await supabase
        .from('content_platforms')
        .upsert(platformRecords, { onConflict: 'content_id,platform_id,region', ignoreDuplicates: false })
        .select('id')

      if (platUpsertErr) {
        logWarn(`Platform upsert failed for batch: ${platUpsertErr.message}`)
      } else {
        platformsUpserted += ((upsertedPlatforms ?? []) as { id: string }[]).length
      }
    }

    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, tagged.length)}/${tagged.length}`)
  }

  process.stdout.write('\r')
  logOk(`${contentUpserted.toLocaleString()} content rows upserted`)
  logOk(`${platformsUpserted.toLocaleString()} platform records upserted`)
  log(`  Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`)

  return { contentUpserted, platformsUpserted }
}

// ─── Sync Job Update ──────────────────────────────────────────────────────────

async function completeSyncJob(
  supabase: AnySupabaseClient,
  syncJobId: string,
  metadata: SyncJobMetadata,
  status: 'completed' | 'failed'
): Promise<void> {
  await supabase
    .from('sync_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      records_processed: metadata.phase_results.write?.content_upserted ?? 0,
      metadata,
    })
    .eq('id', syncJobId)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pipelineStart = Date.now()
  console.log('\n━━━ WatchWise Content Seed Pipeline ━━━\n')
  console.log('[Phase 0] Setup & validation...')

  const { supabase, syncJobId } = await setup()

  const tmdb = createTMDbClient(process.env.TMDB_API_KEY!)
  const streamingClient = createStreamingApiClient(
    process.env.STREAMING_API_KEY!,
    process.env.STREAMING_API_BASE_URL!,
    'us'
  )

  const metadata: SyncJobMetadata = {
    seed_mode: SEED_MODE,
    phase_results: {},
    skipped_summary: {},
    unmapped_keywords: [],
  }

  try {
    // Phase 1
    const p1Start = Date.now()
    const { candidates, rawFetched } = await fetchCandidates(tmdb)
    metadata.phase_results.fetch_candidates = {
      raw_fetched: rawFetched,
      after_dedup: candidates.length,
      after_vote_filter: candidates.length,
      by_type: countByType(candidates),
      duration_ms: Date.now() - p1Start,
    }

    // Phase 2
    const p2Start = Date.now()
    const { available, notAvailable, apiErrors: availApiErrors, checkedByType, availableByType } =
      await checkAvailability(candidates, streamingClient)
    metadata.phase_results.availability_check = {
      checked: candidates.length,
      available: available.length,
      not_available: notAvailable,
      api_errors: availApiErrors,
      checked_by_type: checkedByType,
      available_by_type: availableByType,
      duration_ms: Date.now() - p2Start,
    }
    metadata.skipped_summary.not_available = notAvailable

    // Phase 3
    const p3Start = Date.now()
    const { enriched, skippedMissingOverview, skippedApiError } = await enrichContent(available, tmdb)
    metadata.phase_results.enrichment = {
      attempted: available.length,
      succeeded: enriched.length,
      skipped_missing_overview: skippedMissingOverview,
      skipped_api_error: skippedApiError,
      duration_ms: Date.now() - p3Start,
    }
    if (skippedMissingOverview > 0) metadata.skipped_summary.missing_overview = skippedMissingOverview
    if (skippedApiError > 0) metadata.skipped_summary.api_error = skippedApiError

    // Phase 4
    const tagMappings = await loadTagMappings(supabase)
    const { tagged, allUnmappedKeywords } = await deriveTagsAndBuildEmbeddingInput(enriched, tagMappings)
    metadata.unmapped_keywords = allUnmappedKeywords

    // Phase 5
    const p5Start = Date.now()
    const { contentUpserted, platformsUpserted } = await writeToDatabase(tagged, supabase)
    metadata.phase_results.write = {
      content_upserted: contentUpserted,
      platforms_upserted: platformsUpserted,
      duration_ms: Date.now() - p5Start,
    }

    const totalMs = Date.now() - pipelineStart
    metadata.total_duration_ms = totalMs

    await completeSyncJob(supabase, syncJobId, metadata, 'completed')

    const mins = Math.floor(totalMs / 60_000)
    const secs = Math.floor((totalMs % 60_000) / 1000)
    console.log(`\n━━━ Done in ${mins}m ${secs}s — sync job ${syncJobId} marked complete ━━━\n`)
    console.log('Next step: run the embedding pipeline (Step 5) to populate the embedding column.')

  } catch (err) {
    logErr(`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`)
    metadata.total_duration_ms = Date.now() - pipelineStart
    await completeSyncJob(supabase, syncJobId, metadata, 'failed')
    process.exit(1)
  }
}

main()
