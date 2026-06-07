// Onboarding orchestrator: bootstraps an anonymous session, eager-loads the swipe deck, walks the
// user through welcome → swipe → questions, persists results, and redirects to Discovery.
//
// Graceful: if anonymous sign-in is unavailable the flow still runs; persistence may fail at the end,
// in which case we surface a message and let the user continue to the app rather than getting stuck.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { completeOnboarding, fetchOnboardingDeck } from '@/lib/api/onboarding'
import { JUST_ONBOARDED_KEY } from '@/lib/onboarding/post-onboarding-signal'
import type { Swipe } from '@/lib/types/onboarding'
import { Button } from '@/components/ui/button'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { CategorySwipeDeck } from '@/components/onboarding/SwipeDeck'
import { FollowUpQuestions, type FollowUpAnswers } from '@/components/onboarding/FollowUpQuestions'

type Step = 'welcome' | 'swipe' | 'questions'

export function OnboardingFlow() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('welcome')
  const swipesRef = useRef<Swipe[]>([])

  // Bootstrap an anonymous session up front so persistence has an identity.
  useEffect(() => {
    const supabase = createClient()
    void (async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) await supabase.auth.signInAnonymously().catch(() => undefined)
    })()
  }, [])

  // Eager-load the deck so it's ready by the time the user taps "Start".
  const deck = useQuery({
    queryKey: ['onboarding-deck'],
    queryFn: ({ signal }) => fetchOnboardingDeck(signal),
    staleTime: Infinity,
  })

  const complete = useMutation({
    mutationFn: completeOnboarding,
    onSuccess: () => {
      // One-time signal for the discovery page to show the "Results tuned to your taste" banner. Read
      // and cleared once there (see TasteTunedBanner). sessionStorage so it never persists across tabs/sessions.
      try {
        sessionStorage.setItem(JUST_ONBOARDED_KEY, '1')
      } catch {
        // Storage unavailable (private mode quotas etc.) — the banner just won't show; non-critical.
      }
      router.replace('/')
    },
  })

  function handleDeckComplete(swipes: Swipe[]) {
    swipesRef.current = swipes
    setStep('questions')
  }

  function handleSubmit(answers: FollowUpAnswers) {
    complete.mutate({ swipes: swipesRef.current, platforms: answers.platforms, preferences: answers.preferences })
  }

  // Submitting / success overlay — full viewport, centered.
  if (complete.isPending || complete.isSuccess) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 px-4 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-foreground" />
        <p className="text-lg font-semibold">Lining up your picks…</p>
        <p className="text-sm text-muted-foreground">Reading your taste and finding the good stuff.</p>
      </div>
    )
  }

  if (step === 'welcome') {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center px-4 py-10">
        <WelcomeStep onStart={() => setStep('swipe')} disabled={deck.isError} />
      </div>
    )
  }

  if (step === 'swipe') {
    // Fixed-height viewport box (dvh) with safe-area padding, so the deck's flex layout keeps the card +
    // action buttons fully on-screen without scrolling, on every phone.
    return (
      <div className="flex h-[100dvh] w-full flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {deck.isLoading && (
          <div className="m-auto flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-sm">Picking some titles…</p>
          </div>
        )}
        {deck.isError && (
          <div className="m-auto flex flex-col items-center gap-3 text-center">
            <p className="inline-flex items-center gap-2 font-medium text-destructive">
              <AlertCircle className="h-5 w-5" /> Couldn&rsquo;t load titles
            </p>
            <Button variant="outline" onClick={() => deck.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {deck.isSuccess &&
          (deck.data.length === 0 || deck.data.every((c) => c.titles.length === 0) ? (
            <div className="m-auto flex flex-col items-center gap-3 text-center">
              <p className="text-muted-foreground">No titles to show right now.</p>
              <Button onClick={() => setStep('questions')}>Continue</Button>
            </div>
          ) : (
            <CategorySwipeDeck categories={deck.data} onComplete={handleDeckComplete} />
          ))}
      </div>
    )
  }

  // step === 'questions'
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 px-4 py-10">
      <FollowUpQuestions onSubmit={handleSubmit} submitting={complete.isPending} />
      {complete.isError && (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="inline-flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {complete.error.message}
          </p>
          <Button variant="ghost" onClick={() => router.replace('/')}>
            Continue anyway
          </Button>
        </div>
      )}
    </div>
  )
}
