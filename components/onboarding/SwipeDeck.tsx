// The swipe deck: shows the top card (draggable) with the next card scaled behind it, a progress
// bar, and Dislike/Skip/Like buttons that drive the same fly-off animation as a drag. Collects
// liked/disliked swipes (skips send nothing) and calls onComplete when the deck is exhausted.

'use client'

import { useRef, useState } from 'react'
import { Heart, X, ChevronsUp } from 'lucide-react'
import type { Swipe, SwipeTitle } from '@/lib/types/onboarding'
import { CardFace, SwipeCard, type SwipeCardHandle, type SwipeDecision } from '@/components/onboarding/SwipeCard'

export function SwipeDeck({ titles, onComplete }: { titles: SwipeTitle[]; onComplete: (swipes: Swipe[]) => void }) {
  const [index, setIndex] = useState(0)
  const swipes = useRef<Swipe[]>([])
  const cardRef = useRef<SwipeCardHandle>(null)

  const total = titles.length
  const top = titles[index]
  const behind = titles[index + 1]

  function handleDecision(decision: SwipeDecision) {
    const current = titles[index]
    if (current && decision !== 'skip') {
      swipes.current.push({ contentId: current.id, sentiment: decision })
    }
    const next = index + 1
    if (next >= total) onComplete(swipes.current)
    else setIndex(next)
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5">
      <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {Math.min(index + 1, total)} of {total}
      </p>

      <div className="relative mx-auto aspect-[2/3] w-full">
        {behind && (
          <div className="absolute inset-0 scale-[0.96] opacity-80">
            <CardFace title={behind} />
          </div>
        )}
        {top && <SwipeCard key={top.id} ref={cardRef} title={top} onDecision={handleDecision} />}
      </div>

      <div className="flex items-center justify-center gap-5">
        <button
          type="button"
          aria-label="Pass"
          onClick={() => cardRef.current?.swipe('disliked')}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-rose-300 text-rose-500 transition-colors hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          <X className="h-6 w-6" />
        </button>
        <button
          type="button"
          aria-label="Not Seen"
          onClick={() => cardRef.current?.swipe('skip')}
          className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-sky-300 text-sky-500 transition-colors hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <ChevronsUp className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Like"
          onClick={() => cardRef.current?.swipe('liked')}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-emerald-300 text-emerald-500 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <Heart className="h-6 w-6" />
        </button>
      </div>
    </div>
  )
}
