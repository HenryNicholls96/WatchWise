// POST /api/telemetry — a tiny sink for client-side UX events (e.g. the post-onboarding banner) so they
// land in the same structured-log stream as the server events, with release stamping for slicing by deploy.
//
// Deliberately minimal + safe: the event name is an ALLOW-LIST (a client can't spam arbitrary log lines),
// the body is Zod-validated, it's rate-limited, and identity is NOT required (these are anonymous UX
// signals). `eventId` is the client-generated correlator that ties a lifecycle together (shown → dismissed),
// the same role journeyId plays for a recommendation request.

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { consoleLogger } from '@/lib/types/logger'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { clientIpFromHeaders } from '@/lib/utils/client-ip'
import { getCurrentRelease } from '@/lib/utils/observability'

export const runtime = 'nodejs'

const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 60

// Closed vocabulary of client UX events we accept. Extend deliberately.
const CLIENT_EVENTS = ['banner_shown', 'banner_dismissed'] as const

const telemetrySchema = z.object({
  event: z.enum(CLIENT_EVENTS),
  /** Correlator tying a lifecycle together (e.g. one banner's shown→dismissed). */
  eventId: z.string().max(64).optional(),
  /** Where the event originated, for filtering. */
  surface: z.string().max(48).optional(),
})

export async function POST(req: Request): Promise<NextResponse> {
  const logger = consoleLogger
  const requestId = randomUUID()

  try {
    const ip = clientIpFromHeaders((name) => req.headers.get(name))
    const rl = await checkRateLimit(`telemetry:ip:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many events.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } })
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
    }
    const parsed = telemetrySchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    }
    const { event, eventId, surface } = parsed.data

    // Same structured-event + release-stamping convention as the recommendation events.
    logger.info(event, {
      event,
      requestId,
      eventId: eventId ?? '',
      surface: surface ?? 'unknown',
      release: getCurrentRelease(),
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    logger.warn('telemetry route error', { message: err instanceof Error ? err.message : String(err) })
    // Telemetry must never matter to the client — succeed quietly even on an internal hiccup.
    return new NextResponse(null, { status: 204 })
  }
}
