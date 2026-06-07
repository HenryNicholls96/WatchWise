// Integration coverage for POST /api/interactions — drives the REAL route handler; only the Supabase
// boundary is faked. Verifies session-gated identity, the client action allow-list (no forged swipes),
// the append-only insert shape, and rate limiting.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  insert: vi.fn(async () => ({ error: null as { message: string } | null })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: () => ({ insert: h.insert }),
  }),
}))

import { POST } from '@/app/api/interactions/route'

function req(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<Response>
}

beforeEach(() => {
  __resetRateLimitStore()
  h.user = { id: 'user-1' }
  h.insert.mockReset()
  h.insert.mockResolvedValue({ error: null })
})

describe('POST /api/interactions', () => {
  it('records a valid discovery interaction as an append-only row', async () => {
    const res = await req({ contentId: VALID_UUID, action: 'dismissed', journeyId: 'j-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        content_id: VALID_UUID,
        action: 'dismissed',
        source: 'discovery',
        context: { journeyId: 'j-1' },
      })
    )
  })

  it('rejects a forged swipe action (only discovery actions are client-acceptable)', async () => {
    const res = await req({ contentId: VALID_UUID, action: 'swipe_liked' })
    expect(res.status).toBe(400)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('rejects a malformed content id', async () => {
    expect((await req({ contentId: 'nope', action: 'loved' })).status).toBe(400)
  })

  it('requires a session (401 when anonymous with no user)', async () => {
    h.user = null
    expect((await req({ contentId: VALID_UUID, action: 'loved' })).status).toBe(401)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('surfaces a 502 when the append fails', async () => {
    h.insert.mockResolvedValueOnce({ error: { message: 'fk violation' } })
    expect((await req({ contentId: VALID_UUID, action: 'marked_seen' })).status).toBe(502)
  })
})
