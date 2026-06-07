// POST /api/interactions — append a single lightweight discovery signal (dismiss / quick sentiment /
// marked-seen) to the immutable user_content_interactions log.
//
// Design: identity comes from the session (never the body); only the discovery-surface action vocabulary
// is accepted (swipe_* actions are written by onboarding, not forgeable here); the write goes through the
// USER-scoped Supabase client so RLS enforces user_id = auth.uid(). Append-only — we never update/delete.
// The UI updates optimistically, so this endpoint just needs to be fast and durable, not chatty.

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { consoleLogger } from '@/lib/types/logger'
import { interactionRequestSchema } from '@/lib/types/interactions'
import { checkRateLimit } from '@/lib/utils/rate-limit'
import { clientIpFromHeaders } from '@/lib/utils/client-ip'
import { getCurrentRelease } from '@/lib/utils/observability'

export const runtime = 'nodejs'

// Generous: these are cheap writes a user can fire a few of per session. Still bounded so a loop can't
// hammer the table.
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120

export async function POST(req: Request): Promise<NextResponse> {
  const logger = consoleLogger
  const requestId = randomUUID()

  try {
    const supabase = await createClient()

    // Identity from the session (anonymous or permanent) — never the body.
    const { data: auth } = await supabase.auth.getUser()
    const userId = auth.user?.id
    if (!userId) {
      return NextResponse.json({ error: 'You need an active session to record this.' }, { status: 401, headers: { 'x-request-id': requestId } })
    }

    const ip = clientIpFromHeaders((name) => req.headers.get(name))
    const rl = await checkRateLimit(`interactions:${userId || `ip:${ip}`}`, RATE_LIMIT, RATE_WINDOW_MS)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many actions. Please slow down.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds), 'x-request-id': requestId } }
      )
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const parsed = interactionRequestSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: { 'x-request-id': requestId } })
    }
    const { contentId, action, journeyId } = parsed.data

    const { error } = await supabase.from('user_content_interactions').insert({
      user_id: userId,
      content_id: contentId,
      action,
      source: 'discovery',
      context: journeyId ? { journeyId } : {},
    })
    if (error) {
      logger.warn('interaction insert failed', { message: error.message, action })
      return NextResponse.json({ error: 'Could not record that right now.' }, { status: 502, headers: { 'x-request-id': requestId } })
    }

    // Reuse the structured-event + release-stamping convention (correlates with the originating journey).
    logger.info('interaction_event', { event: 'interaction_event', requestId, journeyId: journeyId ?? '', action, outcome: 'ok', release: getCurrentRelease() })
    return NextResponse.json({ ok: true }, { headers: { 'x-request-id': requestId } })
  } catch (err) {
    logger.error('interactions route error', { message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500, headers: { 'x-request-id': requestId } })
  }
}
