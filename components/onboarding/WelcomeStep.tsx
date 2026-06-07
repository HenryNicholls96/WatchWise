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
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Let&rsquo;s learn your taste</h1>
        <p className="text-muted-foreground">Five quick rounds of swiping — about five minutes.</p>
      </div>

      <div className="rounded-xl border bg-muted/40 p-4 text-left text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Five minutes now, far sharper picks forever.</p>
        <p className="mt-1">
          You&rsquo;ll react to 50 titles across five genres — Like it, Pass, or Not Seen. The more honestly
          you swipe, the better your recommendations get from your very first search. No wrong answers; just go
          with your gut. (We may show a gem you&rsquo;ve already seen — that&rsquo;s a hint, not a mistake.)
        </p>
      </div>

      <Button size="lg" className="h-12 w-full" onClick={onStart} disabled={disabled}>
        Start Swiping
      </Button>
    </div>
  )
}
