// Integration coverage for POST /api/telemetry — drives the REAL route. No external boundaries to fake
// (no DB); just asserts the allow-list, validation, and the fire-and-forget 204 contract.

import { beforeEach, describe, expect, it } from 'vitest'
import { __resetRateLimitStore } from '@/lib/utils/rate-limit'
import { POST } from '@/app/api/telemetry/route'

function req(body: unknown, raw = false): Promise<Response> {
  return POST(
    new Request('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  ) as unknown as Promise<Response>
}

beforeEach(() => {
  __resetRateLimitStore()
})

describe('POST /api/telemetry', () => {
  it('accepts an allow-listed event and returns 204', async () => {
    const res = await req({ event: 'banner_shown', eventId: 'banner-x', surface: 'discovery' })
    expect(res.status).toBe(204)
  })

  it('accepts the dismissed event too', async () => {
    expect((await req({ event: 'banner_dismissed', eventId: 'banner-x' })).status).toBe(204)
  })

  it('rejects an event name outside the allow-list (no arbitrary log spam)', async () => {
    expect((await req({ event: 'arbitrary_spam' })).status).toBe(400)
  })

  it('rejects malformed JSON', async () => {
    expect((await req('{not json', true)).status).toBe(400)
  })
})
