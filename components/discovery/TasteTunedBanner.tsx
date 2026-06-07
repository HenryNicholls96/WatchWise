// One-time, post-onboarding reassurance banner: "Results tuned to your taste". Reads a one-shot
// sessionStorage signal set when onboarding completes, shows once with a calm fade + slide-in, and
// clears the signal immediately so a refresh (or revisit) never shows it again. Self-contained; no props,
// no backend. Purely a confidence cue that the 50 swipes did something — shown, then it gets out of the way.

'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { JUST_ONBOARDED_KEY } from '@/lib/onboarding/post-onboarding-signal'

// Auto-dismiss so it never lingers if the user ignores it — calm, not naggy.
const AUTO_DISMISS_MS = 7000

export function TasteTunedBanner() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Read-and-clear the one-shot signal. Clearing immediately makes this strictly once-per-onboarding:
    // a refresh re-mounts but the key is already gone. (StrictMode double-invoke in dev is harmless —
    // the second pass reads null.)
    let signalled = false
    try {
      signalled = sessionStorage.getItem(JUST_ONBOARDED_KEY) === '1'
      if (signalled) sessionStorage.removeItem(JUST_ONBOARDED_KEY)
    } catch {
      // sessionStorage unavailable — simply don't show. Non-critical.
    }
    if (!signalled) return

    // Defer the reveal to the next tick: keeps the first client render identical to SSR (no hydration
    // mismatch, since we can't read storage during render) and avoids a synchronous setState cascade.
    const reveal = setTimeout(() => setShow(true), 0)
    const hide = setTimeout(() => setShow(false), AUTO_DISMISS_MS)
    return () => {
      clearTimeout(reveal)
      clearTimeout(hide)
    }
  }, [])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          // Soft fade + subtle downward slide-in; gentle ease, nothing flashy.
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          role="status"
          aria-live="polite"
          className="mb-6 w-full max-w-5xl"
        >
          <div className="flex items-center gap-3 rounded-xl border border-accent/60 bg-accent/40 px-4 py-3 backdrop-blur-sm">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/70">
              <Sparkles className="h-4 w-4 text-foreground/70" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug">Results tuned to your taste</p>
              <p className="text-xs text-muted-foreground">
                Your swipes are shaping what you see. Search below, or browse your picks.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShow(false)}
              aria-label="Dismiss"
              className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
