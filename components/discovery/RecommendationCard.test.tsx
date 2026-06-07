// Behaviour tests for the "Already seen" experience on a recommendation card: the calm badge, the
// progressive-disclosure sentiment tray it reveals, and optimistic dismiss with restore-on-failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Recommendation } from '@/lib/api/recommendations'
import { RecommendationCard } from '@/components/discovery/RecommendationCard'

const recordInteraction = vi.fn<(...args: unknown[]) => Promise<boolean>>()
vi.mock('@/lib/api/interactions', () => ({
  recordInteraction: (...args: unknown[]) => recordInteraction(...args),
}))

const CONTENT_ID = '11111111-1111-4111-8111-111111111111'

// The card only reads content.*, confidence, platforms, alreadySeen and the siblings array, so we
// populate just those and cast — building the full ContentRow/ScoreBreakdown shape would add noise
// without exercising anything the component touches.
function makeRec(alreadySeen: boolean): Recommendation {
  return {
    content: {
      id: CONTENT_ID,
      title: 'Test Movie',
      type: 'movie',
      releaseYear: 2020,
      description: 'A gripping tale. It keeps going.',
      genres: ['Drama'],
      moodTags: [],
      themeTags: [],
      runtimeMinutes: 120,
      seasonCount: null,
      posterUrl: null,
      blendedRating: 80,
      tmdbRating: 7.5,
      ratingSources: null,
    },
    confidence: 'high',
    platforms: [],
    alreadySeen,
  } as unknown as Recommendation
}

function renderCard(alreadySeen = true) {
  const rec = makeRec(alreadySeen)
  return render(<RecommendationCard recommendation={rec} siblings={[rec]} />)
}

beforeEach(() => {
  recordInteraction.mockReset()
  recordInteraction.mockResolvedValue(true)
})
afterEach(cleanup)

describe('RecommendationCard — Already seen', () => {
  it('shows the "Already seen" badge only when the title has been seen', () => {
    const { rerender } = render(
      (() => {
        const rec = makeRec(false)
        return <RecommendationCard recommendation={rec} siblings={[rec]} />
      })()
    )
    expect(screen.queryByRole('button', { name: /already seen/i })).toBeNull()

    const seen = makeRec(true)
    rerender(<RecommendationCard recommendation={seen} siblings={[seen]} />)
    expect(screen.getByRole('button', { name: /already seen/i })).toBeInTheDocument()
  })

  it('reveals the sentiment tray when the badge is tapped, and logs the chosen sentiment', async () => {
    const user = userEvent.setup()
    renderCard(true)

    expect(screen.queryByRole('button', { name: /loved it/i })).toBeNull()

    await user.click(screen.getByRole('button', { name: /already seen/i }))
    const loved = await screen.findByRole('button', { name: /loved it/i })
    expect(screen.getByRole('button', { name: /not for me/i })).toBeInTheDocument()

    await user.click(loved)
    expect(recordInteraction).toHaveBeenCalledWith(CONTENT_ID, 'loved')
    expect(await screen.findByText(/thanks — noted/i)).toBeInTheDocument()
  })

  it('optimistically dismisses (removes the card) and logs the dismiss signal', async () => {
    const user = userEvent.setup()
    renderCard(true)

    expect(screen.getByText('Test Movie')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /dismiss test movie/i }))

    expect(recordInteraction).toHaveBeenCalledWith(CONTENT_ID, 'dismissed')
    await waitFor(() => expect(screen.queryByText('Test Movie')).toBeNull())
  })

  it('restores the card and shows a calm note when the dismiss fails to persist', async () => {
    recordInteraction.mockResolvedValue(false)
    const user = userEvent.setup()
    renderCard(true)

    await user.click(screen.getByRole('button', { name: /dismiss test movie/i }))

    expect(await screen.findByText(/try again in a moment/i)).toBeInTheDocument()
    // The card is back: its title is still rendered.
    expect(screen.getByText('Test Movie')).toBeInTheDocument()
  })
})
