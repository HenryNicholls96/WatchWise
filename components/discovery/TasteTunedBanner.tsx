// One-time, post-onboarding reassurance banner: tells the user their swipes now shape their results.
// Reads a one-shot sessionStorage signal set when onboarding completes, shows once with a calm fade +
// slide-in, and clears the signal immediately so a refresh/revisit never shows it again. Dismissal is
// primarily user-driven (✕); a long safety timeout removes it eventually if ignored. Self-contained;
// no props, no backend beyond a fire-and-forget telemetry ping.

'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { JUST_ONBOARDED_KEY } from '@/lib/onboarding/post-onboarding-signal'
import { trackEvent } from '@/lib/api/telemetry'

// User-action is the primary dismiss. This is only a generous safety net so it can't linger forever if
// the user wanders off — long enough to comfortably read and internalize the message.
const SAFETY_DISMISS_MS = 25_000
const SURFACE = 'discovery'

export function TasteTunedBanner() {
  const [show, setShow] = useState(false)
  // Correlates this banner's shown → dismissed events (the journeyId role, scoped to one banner).
  const eventIdRef = useRef('')

  useEffect(() => {
    // Read-and-clear the one-shot signal. Clearing immediately makes this strictly once-per-onboarding:
    // a refresh re-mounts but the key is already gone. (StrictMode double-invoke in dev is harmless.)
    let signalled = false
    try {
      signalled = sessionStorage.getItem(JUST_ONBOARDED_KEY) === '1'
      if (signalled) sessionStorage.removeItem(JUST_ONBOARDED_KEY)
    } catch {
      // sessionStorage unavailable — simply don't show. Non-critical.
    }
    if (!signalled) return

    eventIdRef.current = `banner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    // Defer the reveal to the next tick: keeps the first client render identical to SSR (no hydration
    // mismatch, since we can't read storage during render) and avoids a synchronous setState cascade.
    const reveal = setTimeout(() => {
      setShow(true)
      trackEvent('banner_shown', { eventId: eventIdRef.current, surface: SURFACE })
    }, 0)
    const safety = setTimeout(() => setShow(false), SAFETY_DISMISS_MS)
    return () => {
      clearTimeout(reveal)
      clearTimeout(safety)
    }
  }, [])

  function dismiss() {
    setShow(false)
    trackEvent('banner_dismissed', { eventId: eventIdRef.current, surface: SURFACE })
  }

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
          className="mb-8 w-full max-w-5xl"
        >
          <div className="flex items-center gap-3 rounded-xl border border-accent/60 bg-accent/40 px-4 py-3 backdrop-blur-sm">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/70">
              <Sparkles className="h-4 w-4 text-foreground/70" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug">Your recommendations are tuned to your taste</p>
              <p className="text-xs text-muted-foreground">
                We&rsquo;ve learned what you love — search for anything, or dive straight into the picks we&rsquo;ve lined up for you.
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
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
