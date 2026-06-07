// Integration coverage for GET /api/onboarding/deck — the 5×10 category deck. Drives the REAL route;
// fakes only the Supabase boundary, returning distinct rows per category (keyed by the overlaps matcher)
// so we can assert the grouped shape AND cross-category de-duplication.

import { describe, expect, it, vi } from 'vitest'

type Row = { id: string; title: string; type: string; release_year: number | null; poster_url: string; genres: string[] }

const h = vi.hoisted(() => ({ byMatcher: new Map<string, Row[]>() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      let matcher = ''
      const chain = {
        select: () => chain,
        not: () => chain,
        gte: () => chain,
        // Captures the category's first genre matcher so we can return that category's rows.
        overlaps: (_col: string, matchers: string[]) => {
          matcher = matchers[0]
          return chain
        },
        order: () => chain,
        limit: () => Promise.resolve({ data: h.byMatcher.get(matcher) ?? [], error: null }),
      }
      return chain
    },
  }),
}))

import { GET } from '@/app/api/onboarding/deck/route'

function row(id: string, title: string): Row {
  return { id, title, type: 'movie', release_year: 2020, poster_url: `https://x/${id}.jpg`, genres: ['Crime'] }
}

describe('GET /api/onboarding/deck', () => {
  it('returns titles grouped by category and de-dupes a title across categories', async () => {
    const A = row('11111111-1111-4111-8111-111111111111', 'A')
    const B = row('22222222-2222-4222-8222-222222222222', 'B')
    const C = row('33333333-3333-4333-8333-333333333333', 'C')
    // 'Crime' = crime_thriller's first matcher; 'Science Fiction' = sci_fi_fantasy's. B is shared.
    h.byMatcher.set('Crime', [A, B])
    h.byMatcher.set('Science Fiction', [B, C])

    const res = (await GET()) as unknown as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as { categories: Array<{ id: string; titles: Array<{ id: string }> }> }

    const crime = body.categories.find((c) => c.id === 'crime_thriller')
    const scifi = body.categories.find((c) => c.id === 'sci_fi_fantasy')
    expect(crime?.titles.map((t) => t.id)).toEqual([A.id, B.id])
    // B already used by crime_thriller → dropped here.
    expect(scifi?.titles.map((t) => t.id)).toEqual([C.id])
    // Empty categories (no rows) are omitted entirely.
    expect(body.categories.every((c) => c.titles.length > 0)).toBe(true)
  })
})
