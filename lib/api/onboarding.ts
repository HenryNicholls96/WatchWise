// Client-side calls for the onboarding flow.

import type { CompleteOnboardingInput, SwipeDeckResponse, SwipeTitle } from '@/lib/types/onboarding'

export async function fetchOnboardingDeck(signal?: AbortSignal): Promise<SwipeTitle[]> {
  const res = await fetch('/api/onboarding/deck', { signal })
  if (!res.ok) {
    const message = await res.json().then((d: { error?: string }) => d.error).catch(() => undefined)
    throw new Error(message || 'Could not load titles.')
  }
  const data = (await res.json()) as SwipeDeckResponse
  return data.titles
}

export async function completeOnboarding(input: CompleteOnboardingInput): Promise<void> {
  const res = await fetch('/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const message = await res.json().then((d: { error?: string }) => d.error).catch(() => undefined)
    throw new Error(message || 'Could not save your preferences.')
  }
}
