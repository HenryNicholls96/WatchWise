// Swipe-left-to-go-back wrapper for the search RESULTS view. A horizontal left swipe past a generous
// threshold calls onSwipeBack (which returns the user to the idle For-You rail). Scroll-safe by design:
// drag="x" + dragDirectionLock means a vertical gesture locks to Y (page scrolls normally) and only a
// horizontal gesture engages the drag; a tap never drags, so cards stay clickable. Used ONLY on results.

'use client'

import { type ReactNode } from 'react'
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'

// Generous so a casual horizontal nudge or a card tap can't trigger it: 120px of finger travel, OR a
// clear leftward flick. offset.x is true pointer displacement (not the damped visual), so this is deliberate.
const SWIPE_OFFSET = 120
const SWIPE_VELOCITY = 600

export function SwipeBackWrapper({ onSwipeBack, children }: { onSwipeBack: () => void; children: ReactNode }) {
  const x = useMotionValue(0)
  // "← For You" hint fades in as the user drags left.
  const hintOpacity = useTransform(x, [-SWIPE_OFFSET, -24], [1, 0])

  function handleDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x <= -SWIPE_OFFSET || info.velocity.x <= -SWIPE_VELOCITY) {
      // Trigger: slide the grid off to the left, then drop back to the idle For-You state.
      const distance = typeof window !== 'undefined' ? window.innerWidth : 600
      animate(x, -distance, { duration: 0.2, ease: 'easeOut' })
      window.setTimeout(onSwipeBack, 190)
    } else {
      animate(x, 0, { type: 'spring', stiffness: 300, damping: 30 })
    }
  }

  return (
    <motion.div
      style={{ x, touchAction: 'pan-y' }}
      drag="x"
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.6}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      className="relative"
    >
      <motion.div
        aria-hidden
        style={{ opacity: hintOpacity }}
        className="pointer-events-none absolute left-0 top-4 z-10 inline-flex items-center gap-1 rounded-full bg-foreground/90 px-3 py-1 text-xs font-medium text-background shadow"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> For You
      </motion.div>
      {children}
    </motion.div>
  )
}
