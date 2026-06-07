// Onboarding welcome — value prop + the ~5-minute disclaimer. The swipe legend lives on the swipe tiles
// (SwipeCard), not here.

'use client'

import { Button } from '@/components/ui/button'
import { WatchWiseMark } from '@/components/brand/WatchWiseLogo'

export function WelcomeStep({ onStart, disabled }: { onStart: () => void; disabled?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 text-center">
      <WatchWiseMark className="h-14 w-14 rounded-2xl text-2xl" />

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Tell Us What You Like</h1>
        <p className="text-muted-foreground">5 quick rounds of swiping</p>
      </div>

      <div className="rounded-xl border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        React to 50 titles across five genres and we&rsquo;ll tee up all of the most relevant titles.
      </div>

      <Button size="lg" className="h-12 w-full" onClick={onStart} disabled={disabled}>
        Start Swiping
      </Button>
    </div>
  )
}
