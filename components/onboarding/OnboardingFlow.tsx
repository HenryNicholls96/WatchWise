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
import type { Swipe } from '@/lib/types/onboarding'
import { Button } from '@/components/ui/button'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { SwipeDeck } from '@/components/onboarding/SwipeDeck'
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
    onSuccess: () => router.replace('/'),
  })

  function handleDeckComplete(swipes: Swipe[]) {
    swipesRef.current = swipes
    setStep('questions')
  }

  function handleSubmit(answers: FollowUpAnswers) {
    complete.mutate({ swipes: swipesRef.current, platforms: answers.platforms, preferences: answers.preferences })
  }

  return (
    <div className="flex w-full flex-1 items-center justify-center px-4 py-10">
      {/* Submitting / success overlay. */}
      {(complete.isPending || complete.isSuccess) && (
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-foreground" />
          <p className="text-lg font-semibold">Lining up your picks…</p>
          <p className="text-sm text-muted-foreground">Reading your taste and finding the good stuff.</p>
        </div>
      )}

      {!complete.isPending && !complete.isSuccess && (
        <>
          {step === 'welcome' && (
            <WelcomeStep onStart={() => setStep('swipe')} disabled={deck.isError} />
          )}

          {step === 'swipe' && (
            <>
              {deck.isLoading && (
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-7 w-7 animate-spin" />
                  <p className="text-sm">Picking some titles…</p>
                </div>
              )}
              {deck.isError && (
                <div className="flex flex-col items-center gap-3 text-center">
                  <p className="inline-flex items-center gap-2 font-medium text-destructive">
                    <AlertCircle className="h-5 w-5" /> Couldn&rsquo;t load titles
                  </p>
                  <Button variant="outline" onClick={() => deck.refetch()}>
                    Try again
                  </Button>
                </div>
              )}
              {deck.isSuccess &&
                (deck.data.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-muted-foreground">No titles to show right now.</p>
                    <Button onClick={() => setStep('questions')}>Continue</Button>
                  </div>
                ) : (
                  <SwipeDeck titles={deck.data} onComplete={handleDeckComplete} />
                ))}
            </>
          )}

          {step === 'questions' && (
            <div className="flex w-full flex-col items-center gap-4">
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
          )}
        </>
      )}
    </div>
  )
}
