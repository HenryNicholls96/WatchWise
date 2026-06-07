// Behaviour tests for the revamped follow-up questions: the conditional Documentary sub-genre section and
// the submitted preferences payload (mediaType / favouriteGenres / documentarySubgenres / avoidGenres).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FollowUpQuestions } from '@/components/onboarding/FollowUpQuestions'

afterEach(cleanup)

function setup() {
  const onSubmit = vi.fn()
  render(<FollowUpQuestions onSubmit={onSubmit} submitting={false} />)
  return { onSubmit, user: userEvent.setup() }
}

describe('FollowUpQuestions', () => {
  it('hides the Documentary sub-genres section until Documentaries or All is chosen', async () => {
    const { user } = setup()
    expect(screen.queryByText('True Crime')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Documentaries' }))
    expect(await screen.findByText('True Crime')).toBeInTheDocument()
  })

  it('also shows the Documentary sub-genres section for "All"', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('Nature & Wildlife')).toBeInTheDocument()
  })

  it('submits mediaType, favourite genres, documentary sub-genres and avoid genres', async () => {
    const { onSubmit, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Documentaries' }))
    await user.click(screen.getByRole('button', { name: 'Crime' })) // favourite
    await screen.findByText('True Crime')
    await user.click(screen.getByRole('button', { name: 'True Crime' })) // doc sub-genre
    await user.click(screen.getByRole('button', { name: 'Horror' })) // avoid
    await user.click(screen.getByRole('button', { name: /let’s get started/i }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({
      platforms: [],
      preferences: {
        mediaType: 'documentary',
        favouriteGenres: ['Crime'],
        documentarySubgenres: ['True Crime'],
        avoidGenres: ['Horror'],
      },
    })
  })

  it('does not send documentary sub-genres when the media type has no docs', async () => {
    const { onSubmit, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Movies' }))
    await user.click(screen.getByRole('button', { name: 'Drama' })) // favourite
    await user.click(screen.getByRole('button', { name: /let’s get started/i }))

    expect(onSubmit.mock.calls[0][0].preferences).toEqual({
      mediaType: 'movie',
      favouriteGenres: ['Drama'],
      documentarySubgenres: [],
      avoidGenres: [],
    })
  })
})
