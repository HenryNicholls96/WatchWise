// Discovery experience: a natural-language search box that calls /api/recommendations and renders
// explained recommendation cards. Handles idle / loading / error / empty / results states.

'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, Search, Sparkles } from 'lucide-react'
import { fetchExplanations, fetchRecommendations } from '@/lib/api/recommendations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConstraintChips } from '@/components/discovery/ConstraintChips'
import { ForYouRail } from '@/components/discovery/ForYouRail'
import { RecommendationCard } from '@/components/discovery/RecommendationCard'
import { RecommendationSkeletonGrid } from '@/components/discovery/RecommendationSkeleton'

const RESULT_LIMIT = 8

const EXAMPLES = [
  'dark psychological thriller series',
  'feel-good comedy to unwind',
  'mind-bending sci-fi movie',
  'gripping true-crime documentary',
]

type SearchVars = { query: string; allowGenres: string[] }

export function DiscoveryView() {
  const [input, setInput] = useState('')

  const mutation = useMutation({
    mutationFn: (vars: SearchVars) =>
      fetchRecommendations({ query: vars.query, limit: RESULT_LIMIT, allowGenres: vars.allowGenres }),
  })

  // Explanations are DEFERRED (modal-only): once the grid is here, prefetch them in the background so a
  // card's "Why This One?" is usually ready by the time it's opened. Keyed by the searched query AND the
  // relaxed-genre set, so it aligns with the grid's result set and refetches when either changes.
  const searchedQuery = mutation.variables?.query
  const searchedAllowGenres = mutation.variables?.allowGenres ?? []
  const hasResults = (mutation.data?.recommendations.length ?? 0) > 0
  const explanationsQuery = useQuery({
    queryKey: ['explanations', searchedQuery, [...searchedAllowGenres].sort().join(',')],
    enabled: Boolean(searchedQuery && hasResults),
    staleTime: Infinity,
    // Sends only the search intent (query + relaxed filters) — the server re-runs its own pipeline; no
    // client ranking data is passed. allowGenres must match the grid call so the result sets align.
    queryFn: () => fetchExplanations(searchedQuery!, { limit: RESULT_LIMIT, allowGenres: searchedAllowGenres }),
  })
  const explanationsById = explanationsQuery.data ?? {}

  // A brand-new search clears any relaxed-genre choices from the previous one.
  function runSearch(query: string) {
    const trimmed = query.trim()
    if (!trimmed || mutation.isPending) return
    setInput(trimmed)
    mutation.mutate({ query: trimmed, allowGenres: [] })
  }

  // Re-run the SAME search with one more soft genre exclusion relaxed (the user clicked its chip).
  function relaxGenre(genre: string) {
    const query = mutation.variables?.query
    if (!query || mutation.isPending) return
    const allowGenres = [...new Set([...searchedAllowGenres, genre])]
    mutation.mutate({ query, allowGenres })
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          runSearch(input)
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What are you in the mood for?"
            aria-label="Describe what you want to watch"
            className="h-12 pl-9 text-base"
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" disabled={mutation.isPending || !input.trim()} className="h-12 px-8">
          {mutation.isPending ? 'Finding…' : 'Show Me'}
        </Button>
      </form>

      {/* Idle state: the personalized For-You rail is the hero; example searches are a quiet secondary row. */}
      {mutation.isIdle && (
        <div className="flex flex-col gap-8">
          <ForYouRail />
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-4 w-4" /> Or search for something specific:
            </span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => runSearch(ex)}
                className="rounded-full border px-3 py-1 text-foreground/80 transition-colors hover:bg-accent"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {mutation.isPending && <RecommendationSkeletonGrid />}

      {mutation.isError && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6">
          <p className="inline-flex items-center gap-2 font-medium text-destructive">
            <AlertCircle className="h-5 w-5" /> We hit a snag
          </p>
          <p className="text-sm text-muted-foreground">{mutation.error.message}</p>
          <Button variant="outline" onClick={() => runSearch(input)}>
            Try again
          </Button>
        </div>
      )}

      {mutation.isSuccess &&
        (mutation.data.recommendations.length === 0 ? (
          <div className="rounded-lg border bg-muted/30 p-8 text-center">
            <p className="font-medium">No matches this time</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try rephrasing, or describe the mood, genre, or a show you loved.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {mutation.data.count} {mutation.data.count === 1 ? 'pick' : 'picks'} for “{searchedQuery}”
            </p>
            <ConstraintChips constraints={mutation.data.appliedConstraints} onRelaxGenre={relaxGenre} />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {mutation.data.recommendations.map((rec) => (
                <RecommendationCard
                  key={rec.content.id}
                  recommendation={rec}
                  siblings={mutation.data.recommendations}
                  explanation={explanationsById[rec.content.id]}
                  explanationLoading={explanationsQuery.isFetching && !explanationsById[rec.content.id]}
                />
              ))}
            </div>
          </div>
        ))}
    </div>
  )
}
