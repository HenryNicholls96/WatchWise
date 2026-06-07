// The 5×10 category swipe deck: walks the user through each category's 10 titles in turn, with a clear
// animated section header, overall "x / 50" progress, and per-category pips. Each card supports three
// actions — Like / Pass / Not Seen — collected with the category + action so affinities can be computed.
// Reuses SwipeCard's drag physics; only the orchestration around it is category-aware.

'use client'

import { useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EyeOff, Heart, X } from 'lucide-react'
import type { Swipe, SwipeCategoryDeck, SwipeTitle } from '@/lib/types/onboarding'
import { CardFace, SwipeCard, type SwipeCardHandle, type SwipeDecision } from '@/components/onboarding/SwipeCard'

/** Builds the swipe payload for one decision: like/dislike seed ranking; 'skip' = Not Seen (no sentiment). */
function toSwipe(title: SwipeTitle, categoryId: string, decision: SwipeDecision): Swipe {
  if (decision === 'liked') return { contentId: title.id, category: categoryId, sentiment: 'liked', action: 'swipe_liked' }
  if (decision === 'disliked') return { contentId: title.id, category: categoryId, sentiment: 'disliked', action: 'swipe_disliked' }
  return { contentId: title.id, category: categoryId, action: 'swipe_not_seen' }
}

export function CategorySwipeDeck({
  categories,
  onComplete,
}: {
  categories: SwipeCategoryDeck[]
  onComplete: (swipes: Swipe[]) => void
}) {
  const [catIndex, setCatIndex] = useState(0)
  const [cardIndex, setCardIndex] = useState(0)
  const swipes = useRef<Swipe[]>([])
  const cardRef = useRef<SwipeCardHandle>(null)

  const { total, offsets } = useMemo(() => {
    const offs: number[] = []
    let running = 0
    for (const c of categories) {
      offs.push(running)
      running += c.titles.length
    }
    return { total: running, offsets: offs }
  }, [categories])

  const category = categories[catIndex]
  const titles = category?.titles ?? []
  const top = titles[cardIndex]
  const behind = titles[cardIndex + 1]
  const done = (offsets[catIndex] ?? 0) + cardIndex

  function handleDecision(decision: SwipeDecision) {
    const current = titles[cardIndex]
    if (current) swipes.current.push(toSwipe(current, category!.id, decision))

    // Next card in this category, else advance to the next category, else finish.
    if (cardIndex + 1 < titles.length) {
      setCardIndex(cardIndex + 1)
    } else if (catIndex + 1 < categories.length) {
      setCatIndex(catIndex + 1)
      setCardIndex(0)
    } else {
      onComplete(swipes.current)
    }
  }

  if (!category || !top) return null

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {/* Progress: count + a thin bar + one pip per category (filled up to the current section). */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>
            {Math.min(done + 1, total)} / {total}
          </span>
          <span className="flex items-center gap-1.5">
            {categories.map((c, i) => (
              <span
                key={c.id}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${i < catIndex ? 'bg-foreground/70' : i === catIndex ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
              />
            ))}
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <motion.div
            className="h-full rounded-full bg-foreground"
            initial={false}
            animate={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Animated category header — crossfades on each section change, segmenting the 50 swipes. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={category.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="text-center"
        >
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {catIndex + 1} of {categories.length}
          </p>
          <h2 className="text-xl font-bold tracking-tight">{category.label}</h2>
          <p className="text-sm text-muted-foreground">{category.blurb}</p>
        </motion.div>
      </AnimatePresence>

      <div className="relative mx-auto aspect-[2/3] w-full">
        {behind && (
          <div className="absolute inset-0 scale-[0.96] opacity-80">
            <CardFace title={behind} />
          </div>
        )}
        <SwipeCard key={top.id} ref={cardRef} title={top} onDecision={handleDecision} />
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
          <EyeOff className="h-5 w-5" />
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
