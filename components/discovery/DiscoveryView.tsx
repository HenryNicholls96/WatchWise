// Discovery experience: a natural-language search box that calls /api/recommendations and renders
// explained recommendation cards. Handles idle / loading / error / empty / results states. The idle state
// is the personalized For-You rail; an "Exclude seen films" toggle filters out titles the user has watched.

'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, Search } from 'lucide-react'
import { fetchExplanations, fetchRecommendations } from '@/lib/api/recommendations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConstraintChips } from '@/components/discovery/ConstraintChips'
import { ForYouRail } from '@/components/discovery/ForYouRail'
import { RecommendationCard } from '@/components/discovery/RecommendationCard'
import { RecommendationSkeletonGrid } from '@/components/discovery/RecommendationSkeleton'
import { SwipeBackWrapper } from '@/components/discovery/SwipeBackWrapper'

const RESULT_LIMIT = 8
const EXCLUDE_SEEN_KEY = 'ww:exclude-seen'

type SearchVars = { query: string; allowGenres: string[]; excludeSeen: boolean }

export function DiscoveryView() {
  const [input, setInput] = useState('')
  // Persisted for the tab session (read once on mount to avoid an SSR/hydration mismatch).
  const [excludeSeen, setExcludeSeen] = useState(false)
  useEffect(() => {
    let on = false
    try {
      on = sessionStorage.getItem(EXCLUDE_SEEN_KEY) === '1'
    } catch {
      // sessionStorage unavailable — default off.
    }
    if (!on) return
    // Deferred so the first client render matches SSR (no hydration mismatch) and we avoid a synchronous
    // setState-in-effect cascade.
    const t = setTimeout(() => setExcludeSeen(true), 0)
    return () => clearTimeout(t)
  }, [])

  const mutation = useMutation({
    mutationFn: (vars: SearchVars) =>
      fetchRecommendations({
        query: vars.query,
        limit: RESULT_LIMIT,
        allowGenres: vars.allowGenres,
        excludeSeen: vars.excludeSeen,
      }),
  })

  // Explanations are DEFERRED (modal-only): prefetched in the background, keyed by the searched query +
  // the relaxed-genre set + excludeSeen, so the re-run aligns with the grid and refetches when any change.
  const searchedQuery = mutation.variables?.query
  const searchedAllowGenres = mutation.variables?.allowGenres ?? []
  const searchedExcludeSeen = mutation.variables?.excludeSeen ?? false
  const hasResults = (mutation.data?.recommendations.length ?? 0) > 0
  const explanationsQuery = useQuery({
    queryKey: ['explanations', searchedQuery, [...searchedAllowGenres].sort().join(','), searchedExcludeSeen],
    enabled: Boolean(searchedQuery && hasResults),
    staleTime: Infinity,
    queryFn: () =>
      fetchExplanations(searchedQuery!, {
        limit: RESULT_LIMIT,
        allowGenres: searchedAllowGenres,
        excludeSeen: searchedExcludeSeen,
      }),
  })
  const explanationsById = explanationsQuery.data ?? {}

  // A brand-new search clears any relaxed-genre choices from the previous one.
  function runSearch(query: string) {
    const trimmed = query.trim()
    if (!trimmed || mutation.isPending) return
    setInput(trimmed)
    mutation.mutate({ query: trimmed, allowGenres: [], excludeSeen })
  }

  // Re-run the SAME search with one more soft genre exclusion relaxed (the user clicked its chip).
  function relaxGenre(genre: string) {
    const query = mutation.variables?.query
    if (!query || mutation.isPending) return
    const allowGenres = [...new Set([...searchedAllowGenres, genre])]
    mutation.mutate({ query, allowGenres, excludeSeen: searchedExcludeSeen })
  }

  // Toggle persists for the session and re-runs the active search immediately so results update in place.
  function toggleExcludeSeen() {
    const next = !excludeSeen
    setExcludeSeen(next)
    try {
      sessionStorage.setItem(EXCLUDE_SEEN_KEY, next ? '1' : '0')
    } catch {
      // ignore
    }
    const query = mutation.variables?.query
    if (query && !mutation.isPending) {
      mutation.mutate({ query, allowGenres: searchedAllowGenres, excludeSeen: next })
    }
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <div className="flex flex-col gap-3">
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

        {/* Exclude-seen toggle — calm pill switch directly below the search controls. */}
        <button
          type="button"
          role="switch"
          aria-checked={excludeSeen}
          onClick={toggleExcludeSeen}
          className="inline-flex items-center gap-2 self-start rounded-full px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${excludeSeen ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${excludeSeen ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`}
            />
          </span>
          Exclude seen films
        </button>
      </div>

      {/* Idle state: the personalized For-You rail. */}
      {mutation.isIdle && <ForYouRail />}

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

      {/* Results view: swipe left (or flick) to clear the search and return to the For-You rail. */}
      {mutation.isSuccess && (
        <SwipeBackWrapper onSwipeBack={() => mutation.reset()}>
          {mutation.data.recommendations.length === 0 ? (
            <div className="rounded-lg border bg-muted/30 p-8 text-center">
              <p className="font-medium">No matches this time</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchedExcludeSeen
                  ? 'Nothing new here — try turning off “Exclude seen films”, or rephrase your search.'
                  : 'Try rephrasing, or describe the mood, genre, or a show you loved.'}
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
          )}
        </SwipeBackWrapper>
      )}
    </div>
  )
}
