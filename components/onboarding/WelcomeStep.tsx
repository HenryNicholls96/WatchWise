// Onboarding welcome — value prop + the "hints, not filters" disclaimer. The swipe legend lives on the
// swipe tiles (SwipeCard), not here.

'use client'

import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function WelcomeStep({ onStart, disabled }: { onStart: () => void; disabled?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-foreground text-background">
        <Sparkles className="h-7 w-7" />
      </span>

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">No more scrolling</h1>
        <p className="text-muted-foreground">A few swipes and we&rsquo;re away...</p>
      </div>

      <div className="rounded-xl border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        These give us hints at your viewing preferences — we may recommend a gem you&rsquo;ve already seen
      </div>

      <Button size="lg" className="h-12 w-full" onClick={onStart} disabled={disabled}>
        Start Swiping
      </Button>
    </div>
  )
}
