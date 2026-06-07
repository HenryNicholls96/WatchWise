// GET /api/onboarding/deck — the 5×10 category swipe deck. For each registry category, returns the most
// popular, poster-bearing titles whose genres overlap that category. Public read (content is public); no
// personalization — this is the cold-start signal the user is about to GIVE us.
//
// Performance: one indexed query per category (genres GIN index + tmdb_vote_count), run in parallel. We
// over-fetch a little so we can de-duplicate a title that qualifies for two categories (it appears in the
// first category only, in registry order), and still land 10 per section in the common case.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { consoleLogger } from '@/lib/types/logger'
import type { SwipeCategoryDeck, SwipeTitle } from '@/lib/types/onboarding'
import { SWIPE_CATEGORIES } from '@/lib/onboarding/categories'

export const runtime = 'nodejs'

const PER_CATEGORY = 10
const OVERFETCH = 18 // headroom for cross-category de-duplication
const MIN_VOTES = 500

type Row = {
  id: string
  title: string
  type: SwipeTitle['type']
  release_year: number | null
  poster_url: string | null
  genres: string[] | null
}

function toTitle(r: Row): SwipeTitle {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    releaseYear: r.release_year,
    posterUrl: r.poster_url,
    genres: r.genres ?? [],
  }
}

export async function GET(): Promise<NextResponse> {
  const logger = consoleLogger
  try {
    const supabase = await createClient()

    // One query per category, in parallel. Each returns the most-voted titles overlapping the category.
    const results = await Promise.all(
      SWIPE_CATEGORIES.map((cat) =>
        supabase
          .from('content')
          .select('id, title, type, release_year, poster_url, genres')
          .not('poster_url', 'is', null)
          .gte('tmdb_vote_count', MIN_VOTES)
          .overlaps('genres', cat.genreMatchers)
          .order('tmdb_vote_count', { ascending: false })
          .limit(OVERFETCH)
      )
    )

    const used = new Set<string>()
    const categories: SwipeCategoryDeck[] = SWIPE_CATEGORIES.map((cat, i) => {
      const { data, error } = results[i]
      if (error) logger.warn('deck category query failed (continuing)', { category: cat.id, message: error.message })
      const titles: SwipeTitle[] = []
      for (const row of ((data ?? []) as Row[])) {
        if (titles.length >= PER_CATEGORY) break
        if (used.has(row.id)) continue // a title belongs to the first category it qualifies for
        used.add(row.id)
        titles.push(toTitle(row))
      }
      return { id: cat.id, label: cat.label, blurb: cat.blurb, titles }
    }).filter((c) => c.titles.length > 0)

    return NextResponse.json({ categories })
  } catch (err) {
    logger.error('onboarding deck route error', { message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
