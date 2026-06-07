// "For You" rail — the persistent, personalized hero of the discovery idle state. It runs the live
// recommendationMode:'for-you' pipeline (TasteProfile → temporary synthetic query; see the TODO(centroid)
// in lib/recommendations/taste-profile.ts) and is the emotional payoff for completing the 50 swipes: the
// moment a user lands here, their taste is already reflected back at them.
//
// Product intent baked into the UX choices below:
//   • Skeletons render INSTANTLY so there's never a blank gap — perceived intelligence depends on speed.
//   • A distinct, premium frame (W mark + accent-gradient panel) makes "this is personalized" obvious,
//     while the cards stay identical to search results for consistency.
//   • The title is HONEST: taste-shaped → "For You"; cold-start fallback → "Popular right now" + a nudge.
//   • Cards stagger in with a soft fade/slide — deliberate, not flashy.

'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { AlertCircle, Sparkles } from 'lucide-react'
import { fetchRecommendations } from '@/lib/api/recommendations'
import { trackEvent } from '@/lib/api/telemetry'
import { Button } from '@/components/ui/button'
import { WatchWiseMark } from '@/components/brand/WatchWiseLogo'
import { RecommendationCard } from '@/components/discovery/RecommendationCard'
import { RecommendationSkeletonGrid } from '@/components/discovery/RecommendationSkeleton'

const FOR_YOU_LIMIT = 12
const SURFACE = 'discovery'
// For-You cards skip the LLM explanation prefetch (no per-idle-visit cost), so the modal shows this calm,
// honest line instead of the search-oriented fallback.
const FOR_YOU_FALLBACK_EXPLANATION = 'Picked because it fits the taste you showed us.'

export function ForYouRail() {
  const query = useQuery({
    queryKey: ['for-you'],
    queryFn: () => fetchRecommendations({ recommendationMode: 'for-you', limit: FOR_YOU_LIMIT }),
    // Returning to idle within the window is instant (no refetch flicker); a deploy/refresh re-fetches.
    staleTime: 5 * 60_000,
  })

  const recs = query.data?.recommendations ?? []
  const personalized = query.data?.personalized ?? false

  // Emit foryou_shown exactly once per mount that yields results.
  const shownRef = useRef(false)
  useEffect(() => {
    if (query.isSuccess && recs.length > 0 && !shownRef.current) {
      shownRef.current = true
      trackEvent('foryou_shown', { surface: SURFACE, personalized, count: recs.length })
    }
  }, [query.isSuccess, recs.length, personalized])

  const title = personalized ? 'For You' : 'Popular right now'
  const subtitle = personalized
    ? 'Tuned to your taste from your swipes.'
    : 'A starting point — swipe a few titles to make this yours.'

  return (
    <section aria-label="Recommendations for you" className="w-full">
      <div className="overflow-hidden rounded-2xl border border-accent/50 bg-gradient-to-b from-accent/40 to-background p-5 sm:p-6">
        <header className="mb-5 flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background/80 shadow-sm">
            <WatchWiseMark className="h-5 w-5 text-xs" />
          </span>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
              {title}
              <Sparkles className="h-4 w-4 text-foreground/40" aria-hidden />
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </header>

        {/* Loading — skeletons appear immediately so the rail never flashes empty. */}
        {query.isLoading && <RecommendationSkeletonGrid count={6} />}

        {query.isError && (
          <div className="flex flex-col items-start gap-3 rounded-lg border bg-background/60 p-5">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <AlertCircle className="h-4 w-4" /> Couldn&rsquo;t load your picks just now.
            </p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {query.isSuccess && recs.length === 0 && (
          <div className="rounded-lg border bg-background/60 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Swipe a few titles and your personalized picks will appear here.
            </p>
          </div>
        )}

        {query.isSuccess && recs.length > 0 && (
          <motion.div
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
            className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
          >
            {recs.map((rec) => (
              <motion.div
                key={rec.content.id}
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="h-full"
              >
                <RecommendationCard
                  recommendation={rec}
                  siblings={recs}
                  fallbackExplanation={FOR_YOU_FALLBACK_EXPLANATION}
                  onOpen={() => trackEvent('foryou_card_opened', { surface: SURFACE, personalized })}
                />
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
    </section>
  )
}
