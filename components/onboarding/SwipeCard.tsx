// The draggable swipe card. Drag physics + an imperative swipe() handle so on-screen buttons and
// gestures share one fly-off animation. Live rotation and LIKE/NOPE/SEEN indicators are driven by
// motion values (compositor-side) for smooth mobile performance.

'use client'

import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import Image from 'next/image'
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion'
import { ChevronsUp, Film, Heart, X } from 'lucide-react'
import type { SwipeTitle } from '@/lib/types/onboarding'

export type SwipeDecision = 'liked' | 'disliked' | 'skip'
export type SwipeCardHandle = { swipe: (decision: SwipeDecision) => void }

// Commit thresholds: distance OR velocity (a quick flick counts even if short).
const OFFSET_THRESHOLD = 120
const VELOCITY_THRESHOLD = 600

function meta(title: SwipeTitle): string {
  const parts: string[] = [title.type === 'movie' ? 'Movie' : 'Series']
  if (title.releaseYear) parts.push(String(title.releaseYear))
  if (title.genres.length > 0) parts.push(title.genres.slice(0, 2).join(', '))
  return parts.join(' · ')
}

export function CardFace({ title }: { title: SwipeTitle }) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl border bg-muted shadow-xl select-none">
      {title.posterUrl ? (
        <Image
          src={title.posterUrl}
          alt={`${title.title} poster`}
          fill
          sizes="(max-width: 640px) 90vw, 384px"
          className="object-cover"
          draggable={false}
          unoptimized
          priority
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Film className="h-10 w-10 text-muted-foreground" aria-hidden />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-4 pt-12">
        <h3 className="text-lg font-semibold leading-tight text-white">{title.title}</h3>
        <p className="text-sm text-white/80">{meta(title)}</p>
        {/* Minimal swipe legend (left / up / right) — mirrors the deck's button icons. */}
        <div className="mt-2.5 flex items-center gap-3 text-[10px] font-medium text-white/70">
          <span className="inline-flex items-center gap-1">
            <X className="h-3 w-3 text-rose-400" aria-hidden /> Pass
          </span>
          <span className="inline-flex items-center gap-1">
            <ChevronsUp className="h-3 w-3 text-sky-400" aria-hidden /> Not Seen
          </span>
          <span className="inline-flex items-center gap-1">
            <Heart className="h-3 w-3 text-emerald-400" aria-hidden /> Like
          </span>
        </div>
      </div>
    </div>
  )
}

function Stamp({ label, className }: { label: string; className: string }) {
  return (
    <div
      className={`pointer-events-none absolute top-6 rounded-md border-4 px-3 py-1 text-xl font-extrabold uppercase tracking-wider ${className}`}
    >
      {label}
    </div>
  )
}

export const SwipeCard = forwardRef<SwipeCardHandle, { title: SwipeTitle; onDecision: (d: SwipeDecision) => void }>(
  function SwipeCard({ title, onDecision }, ref) {
    const x = useMotionValue(0)
    const y = useMotionValue(0)
    const rotate = useTransform(x, [-220, 220], [-16, 16])
    const likeOpacity = useTransform(x, [30, 140], [0, 1])
    const nopeOpacity = useTransform(x, [-140, -30], [1, 0])
    const skipOpacity = useTransform(y, [-140, -30], [1, 0])
    const exiting = useRef(false)

    const fly = useCallback(
      (decision: SwipeDecision) => {
        if (exiting.current) return
        exiting.current = true
        animate(x, decision === 'liked' ? 700 : decision === 'disliked' ? -700 : 0, { duration: 0.3, ease: 'easeOut' })
        animate(y, decision === 'skip' ? -820 : 0, { duration: 0.3, ease: 'easeOut' })
        window.setTimeout(() => onDecision(decision), 250)
      },
      [onDecision, x, y]
    )

    useImperativeHandle(ref, () => ({ swipe: fly }), [fly])

    const handleDragEnd = (_: unknown, info: PanInfo) => {
      const { offset, velocity } = info
      if (offset.x > OFFSET_THRESHOLD || velocity.x > VELOCITY_THRESHOLD) fly('liked')
      else if (offset.x < -OFFSET_THRESHOLD || velocity.x < -VELOCITY_THRESHOLD) fly('disliked')
      else if (offset.y < -OFFSET_THRESHOLD || velocity.y < -VELOCITY_THRESHOLD) fly('skip')
      else {
        animate(x, 0, { type: 'spring', stiffness: 300, damping: 26 })
        animate(y, 0, { type: 'spring', stiffness: 300, damping: 26 })
      }
    }

    return (
      <motion.div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        style={{ x, y, rotate, touchAction: 'none' }}
        drag
        dragElastic={0.7}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        whileTap={{ scale: 0.98 }}
      >
        <CardFace title={title} />
        <motion.div style={{ opacity: likeOpacity }} className="absolute left-6 top-6">
          <Stamp label="Like" className="rotate-[-18deg] border-emerald-400 text-emerald-400" />
        </motion.div>
        <motion.div style={{ opacity: nopeOpacity }} className="absolute right-6 top-6">
          <Stamp label="Pass" className="rotate-[18deg] border-rose-400 text-rose-400" />
        </motion.div>
        <motion.div style={{ opacity: skipOpacity }} className="absolute inset-x-0 top-6 flex justify-center">
          <Stamp label="Not Seen" className="border-sky-400 text-sky-400" />
        </motion.div>
      </motion.div>
    )
  }
)
