// scripts/blend-ratings.ts — resumable Blended Rating enrichment.
//
// For each catalog title that's missing or stale ratings: resolve its imdb_id (from TMDb external_ids
// if not stored), fetch IMDb + Metacritic from OMDb, blend with the stored TMDb rating, and persist
// blended_rating + rating_sources + ratings_updated_at. Resumable and daily-cap aware so it stays
// under OMDb's free 1,000/day limit — just re-run to continue.
//
// Usage:
//   npm run blend:ratings              # process due titles up to the daily cap
//   OMDB_DAILY_CAP=200 npm run blend:ratings
//   RATINGS_STALE_DAYS=90 npm run blend:ratings

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import { createClient } from '@supabase/supabase-js'
import { createOmdbClient } from '../lib/sync/omdb-client'
import { createTMDbClient } from '../lib/sync/tmdb-client'
import { calculateBlendedRating } from '../lib/sync/blended-rating'
import type { ContentType } from '../lib/types/content'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`\n❌ Missing env var ${name}. Run via: npm run blend:ratings\n`)
    process.exit(1)
  }
  return v
}

const STALE_DAYS = Number(process.env.RATINGS_STALE_DAYS ?? 60)
const DAILY_CAP = Number(process.env.OMDB_DAILY_CAP ?? 900) // under OMDb free tier (1000/day)

type Row = {
  id: string
  tmdb_id: number | null
  type: ContentType
  imdb_id: string | null
  tmdb_rating: number | string | null
  tmdb_vote_count: number | null
}

async function main() {
  const supabase = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const omdb = createOmdbClient(requireEnv('OMDB_API_KEY'))
  const tmdb = createTMDbClient(requireEnv('TMDB_API_KEY'))

  const staleBefore = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('content')
    .select('id, tmdb_id, type, imdb_id, tmdb_rating, tmdb_vote_count')
    .or(`ratings_updated_at.is.null,ratings_updated_at.lt.${staleBefore}`)
    .order('ratings_updated_at', { ascending: true, nullsFirst: true })
    .limit(2000)

  if (error) {
    console.error('\n❌ Failed to load titles:', error.message, '\n')
    process.exit(1)
  }

  const rows = (data ?? []) as Row[]
  console.log(`\n━━━ Blended Rating enrichment ━━━`)
  console.log(`Due titles: ${rows.length} · daily cap: ${DAILY_CAP} · stale after: ${STALE_DAYS}d\n`)

  let omdbCalls = 0
  let updated = 0
  let withImdb = 0
  let withMetacritic = 0
  let tmdbOnly = 0
  let failed = 0

  for (const row of rows) {
    if (omdbCalls >= DAILY_CAP) {
      console.log(`\n⏸  Reached daily cap (${DAILY_CAP}). Re-run to continue.`)
      break
    }

    try {
      // 1) Resolve imdb_id (stored, else TMDb external_ids). Catalogue rows (migration 010) may have no
      //    tmdb_id; only fall back to the TMDb lookup when one is present.
      let imdbId = row.imdb_id
      if (!imdbId && row.tmdb_id != null) imdbId = await tmdb.getImdbId(row.tmdb_id, row.type)

      // 2) OMDb (IMDb + Metacritic) — only if we have an imdb_id.
      let imdbRating: number | null = null
      let imdbVotes: number | null = null
      let metascore: number | null = null
      if (imdbId) {
        omdbCalls++
        const ratings = await omdb.getByImdbId(imdbId)
        imdbRating = ratings.imdbRating
        imdbVotes = ratings.imdbVotes
        metascore = ratings.metascore
      }

      // 3) Blend with stored TMDb rating.
      const tmdbRating = row.tmdb_rating == null ? null : Number(row.tmdb_rating)
      const blend = calculateBlendedRating({
        imdb: imdbRating != null ? { rating: imdbRating, votes: imdbVotes } : null,
        metacritic: metascore,
        tmdb: tmdbRating != null ? { rating: tmdbRating, votes: row.tmdb_vote_count } : null,
      })

      const ratingSources = {
        imdb: imdbRating != null ? { rating: imdbRating, votes: imdbVotes } : null,
        metacritic: metascore,
        tmdb: tmdbRating != null ? { rating: tmdbRating, votes: row.tmdb_vote_count } : null,
        contributing: blend.contributing,
      }

      const { error: updateErr } = await supabase
        .from('content')
        .update({
          imdb_id: imdbId,
          imdb_rating: imdbRating,
          blended_rating: blend.blendedRating,
          rating_sources: ratingSources,
          ratings_updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)

      if (updateErr) {
        failed++
        console.warn(`  ✗ ${row.tmdb_id}: update failed — ${updateErr.message}`)
        continue
      }

      updated++
      if (imdbRating != null) withImdb++
      if (metascore != null) withMetacritic++
      if (blend.contributing.length === 1 && blend.contributing[0] === 'tmdb') tmdbOnly++

      if (updated % 25 === 0) {
        console.log(`  …${updated} updated (${omdbCalls} OMDb calls)`)
      }
    } catch (err) {
      failed++
      console.warn(`  ✗ ${row.tmdb_id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n━━━ Done ━━━`)
  console.log(`Updated: ${updated} · OMDb calls: ${omdbCalls}`)
  console.log(`  with IMDb: ${withImdb} · with Metacritic: ${withMetacritic} · TMDb-only fallback: ${tmdbOnly}`)
  console.log(`  failed: ${failed}`)
  const remaining = rows.length - updated - failed
  if (remaining > 0) console.log(`  remaining (re-run): ~${remaining}\n`)
  else console.log('')
}

main()
