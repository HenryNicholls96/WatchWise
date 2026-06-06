// GET /api/onboarding/deck — a curated, genre-diverse set of popular titles for the swipe deck.
// Public read (content is publicly readable); no personalization here — this is the cold-start seed.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { consoleLogger } from '@/lib/types/logger'
import type { SwipeTitle } from '@/lib/types/onboarding'

export const runtime = 'nodejs'

const DECK_SIZE = 10
const PER_GENRE_CAP = 2
const MIN_VOTES = 500

type Row = {
  id: string
  title: string
  type: SwipeTitle['type']
  release_year: number | null
  poster_url: string | null
  genres: string[] | null
}

/** Greedily spread picks across primary genres for variety, then top up if needed. */
function diversify(rows: Row[], max: number): Row[] {
  const counts = new Map<string, number>()
  const out: Row[] = []
  for (const r of rows) {
    if (out.length >= max) break
    const g = r.genres?.[0] ?? 'other'
    const c = counts.get(g) ?? 0
    if (c >= PER_GENRE_CAP) continue
    counts.set(g, c + 1)
    out.push(r)
  }
  if (out.length < max) {
    const chosen = new Set(out.map((r) => r.id))
    for (const r of rows) {
      if (out.length >= max) break
      if (!chosen.has(r.id)) out.push(r)
    }
  }
  return out
}

export async function GET(): Promise<NextResponse> {
  const logger = consoleLogger
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('content')
      .select('id, title, type, release_year, poster_url, genres')
      .not('poster_url', 'is', null)
      .gte('tmdb_vote_count', MIN_VOTES)
      .order('tmdb_vote_count', { ascending: false })
      .limit(80)

    if (error) {
      logger.error('onboarding deck query failed', { message: error.message })
      return NextResponse.json({ error: 'Could not load titles. Please try again.' }, { status: 502 })
    }

    const titles: SwipeTitle[] = diversify((data ?? []) as Row[], DECK_SIZE).map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      releaseYear: r.release_year,
      posterUrl: r.poster_url,
      genres: r.genres ?? [],
    }))

    return NextResponse.json({ titles })
  } catch (err) {
    logger.error('onboarding deck route error', { message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
