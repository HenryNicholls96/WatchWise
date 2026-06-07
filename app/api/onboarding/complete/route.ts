// POST /api/onboarding/complete — persists onboarding results for the signed-in (possibly anonymous)
// user: swipe likes/dislikes → user_taste_seeds, platforms → preferred_platforms, tone/pacing/runtime
// → user_profiles.preferences, and flips onboarding_completed.
//
// IMPORTANT: swipes are stored ONLY as taste seeds (positive/negative signals). Nothing here writes an
// exclusion list — seen/liked titles remain fully recommendable, just boosted/penalized by similarity.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { type Logger, consoleLogger } from '@/lib/types/logger'
import { type Swipe, completeOnboardingSchema } from '@/lib/types/onboarding'
import type { InteractionAction } from '@/lib/types/interactions'
import { computeCategoryAffinities } from '@/lib/recommendations/taste-profile'

export const runtime = 'nodejs'

export async function POST(req: Request): Promise<NextResponse> {
  const logger = consoleLogger

  try {
    const supabase = await createClient()

    // Identity from the session (anonymous or permanent) — never from the body.
    const { data: auth } = await supabase.auth.getUser()
    const userId = auth.user?.id
    if (!userId) {
      return NextResponse.json({ error: 'You need an active session to finish onboarding.' }, { status: 401 })
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
    }
    const parsed = completeOnboardingSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    }
    const { swipes, platforms, preferences } = parsed.data

    // 1) Persist swipe seeds — the CRITICAL write (idempotent via unique(user_id, content_id), so
    //    re-running onboarding overwrites prior sentiment). This is the user's actual taste signal;
    //    if it can't be saved there's nothing to fail open to, so surface the error and let them retry.
    // Only like/dislike swipes seed ranking; 'not_seen' swipes carry no sentiment (they're logged as
    // interactions + a mild affinity signal below, not as taste seeds).
    const seedRows = swipes
      .filter((s) => s.sentiment === 'liked' || s.sentiment === 'disliked')
      .map((s) => ({
        user_id: userId,
        content_id: s.contentId,
        sentiment: s.sentiment,
        category: s.category ?? null,
      }))
    if (seedRows.length > 0) {
      const { error: seedErr } = await supabase
        .from('user_taste_seeds')
        .upsert(seedRows, { onConflict: 'user_id,content_id' })
      if (seedErr) {
        logger.error('taste seed upsert failed', { message: seedErr.message })
        return NextResponse.json({ error: 'Could not save your picks. Please try again.' }, { status: 502 })
      }
    }

    // 1b) Personalization signals — BEST-EFFORT (never blocks completion): append the immutable swipe log
    //     and the derived per-category affinity prior the scorer reads. This is what makes the 50 swipes
    //     actually move the user's results. A failure here just means a slightly weaker first session.
    await persistPersonalizationSignalsBestEffort(supabase, userId, swipes, logger)

    // 2) Persist profile preferences + mark onboarding complete — BEST-EFFORT. Once the seeds above are
    //    saved, onboarding has succeeded from the user's perspective; a profile-write hiccup must never
    //    roll that back nor surface an error. persistProfileBestEffort never throws and always returns,
    //    logging failures at warn (and falling back to a flag-only update so the gate doesn't re-route
    //    a user who's actually done).
    const profileSaved = await persistProfileBestEffort(
      supabase,
      userId,
      { preferred_platforms: platforms, preferences, onboarding_completed: true },
      logger
    )

    logger.info('onboarding complete', { seeds: swipes.length, platforms: platforms.length, profileSaved })
    return NextResponse.json({ ok: true, seeds: swipes.length })
  } catch (err) {
    logger.error('onboarding complete route error', { message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}

/**
 * Best-effort write of the onboarding profile. NEVER throws and NEVER blocks completion: a failure is
 * logged at warn and swallowed. If the full update fails, we still try to set `onboarding_completed`
 * on its own, so a user who finished isn't bounced back into onboarding by the gate over a transient
 * issue writing the richer fields (e.g. preferences). Returns whether the full update landed.
 */
async function persistProfileBestEffort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  fields: { preferred_platforms: string[]; preferences: unknown; onboarding_completed: true },
  logger: Logger
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('user_profiles')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', userId)
    if (!error) return true
    logger.warn('profile update failed (continuing; seeds already saved)', { message: error.message })
  } catch (err) {
    logger.warn('profile update threw (continuing; seeds already saved)', {
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // Fallback: at minimum record completion, so the onboarding gate doesn't loop the user back.
  try {
    const { error } = await supabase
      .from('user_profiles')
      .update({ onboarding_completed: true, updated_at: new Date().toISOString() })
      .eq('id', userId)
    if (error) logger.warn('onboarding flag fallback update failed', { message: error.message })
  } catch (err) {
    logger.warn('onboarding flag fallback threw', { message: err instanceof Error ? err.message : String(err) })
  }
  return false
}

/** Maps a swipe to its append-only interaction action (explicit `action` wins; else derived from sentiment). */
function swipeAction(s: Swipe): InteractionAction {
  if (s.action) return s.action
  return s.sentiment === 'liked' ? 'swipe_liked' : 'swipe_disliked'
}

/**
 * Writes the append-only interaction log + the derived per-category affinity rows. NEVER throws and NEVER
 * blocks onboarding completion — the taste seeds above are the load-bearing write; these enrich ranking.
 * Affinity is only computed from swipes that carry a `category` (the new 5×10 deck); older payloads without
 * categories simply produce no affinity rows (and ranking falls back to seed overlap), so this is safe to
 * ship ahead of the new swipe UI.
 */
async function persistPersonalizationSignalsBestEffort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  swipes: Swipe[],
  logger: Logger
): Promise<void> {
  if (swipes.length === 0) return

  // Append-only interaction rows (immutable record of every swipe).
  try {
    const interactions = swipes.map((s) => ({
      user_id: userId,
      content_id: s.contentId,
      action: swipeAction(s),
      category: s.category ?? null,
      source: 'onboarding',
    }))
    const { error } = await supabase.from('user_content_interactions').insert(interactions)
    if (error) logger.warn('interaction log insert failed (non-fatal)', { message: error.message })
  } catch (err) {
    logger.warn('interaction log insert threw (non-fatal)', { message: err instanceof Error ? err.message : String(err) })
  }

  // Derived category affinities (the signal the scorer reads). Pure compute, then idempotent upsert.
  try {
    const signals = swipes
      .filter((s) => s.category)
      .map((s) => ({ category: s.category!, action: swipeAction(s) as 'swipe_liked' | 'swipe_disliked' | 'swipe_not_seen' }))
    const rows = computeCategoryAffinities(signals).map((r) => ({
      user_id: userId,
      category: r.category,
      affinity: r.affinity,
      sample_count: r.sampleCount,
      updated_at: new Date().toISOString(),
    }))
    if (rows.length > 0) {
      const { error } = await supabase.from('user_category_affinity').upsert(rows, { onConflict: 'user_id,category' })
      if (error) logger.warn('category affinity upsert failed (non-fatal)', { message: error.message })
    }
  } catch (err) {
    logger.warn('category affinity upsert threw (non-fatal)', { message: err instanceof Error ? err.message : String(err) })
  }
}
