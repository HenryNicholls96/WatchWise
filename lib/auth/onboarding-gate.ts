// Onboarding gate — reads the current session user's onboarding status for server-side routing.
//
// Guarantees:
//   • FAIL-OPEN: any auth/profile error resolves to a non-redirecting state, so a transient issue
//     never traps someone. Failures are logged (not silently swallowed) for observability.
//   • LOOP-SAFE: `completed` is only `false` for a signed-in user whose profile says so. A visitor
//     with no session resolves to { hasUser: false, completed: null } and is never redirected — so
//     the flow stays clean today (before anonymous sign-in is enabled) and is ready for it later.
//
// End-to-end routing (see app/page.tsx and app/onboarding/page.tsx):
//   • completed === false  → "/" redirects to "/onboarding"
//   • completed === true   → "/onboarding" redirects to "/"
//   • completed === null   → neither page redirects (unknown / no session)

import { createClient } from '@/lib/supabase/server'
import { consoleLogger } from '@/lib/types/logger'

export const ONBOARDING_PATH = '/onboarding'
export const DISCOVERY_PATH = '/'

export type OnboardingState = {
  /** True when a session user exists (authenticated OR, in future, anonymous). */
  hasUser: boolean
  /** true = done · false = signed in but not done · null = unknown / no session. */
  completed: boolean | null
}

export async function getOnboardingState(): Promise<OnboardingState> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    // "No session" is the normal anonymous case — don't treat it as an error worth logging.
    if (authError && authError.name !== 'AuthSessionMissingError') {
      consoleLogger.warn('onboarding-gate: auth check failed (treating as no session)', {
        message: authError.message,
      })
    }
    if (!user) return { hasUser: false, completed: null }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('onboarding_completed')
      .eq('id', user.id)
      .maybeSingle()

    if (error) {
      // Signed in but we couldn't read the flag — stay fail-open (no redirect) rather than guess.
      consoleLogger.warn('onboarding-gate: profile read failed (treating as unknown)', { message: error.message })
      return { hasUser: true, completed: null }
    }

    return { hasUser: true, completed: (data?.onboarding_completed as boolean | undefined) ?? null }
  } catch (err) {
    consoleLogger.warn('onboarding-gate: unexpected error (fail-open)', {
      message: err instanceof Error ? err.message : String(err),
    })
    return { hasUser: false, completed: null }
  }
}

// ─── EXTENSION POINT: auto-onboard brand-new visitors (not implemented yet) ─────
//
// Today we never redirect a no-session visitor (would loop while anonymous sign-in is disabled, since
// onboarding can't create a session to satisfy the gate). Once anonymous sign-ins are enabled, the
// clean way to funnel new visitors into onboarding is to bootstrap an anonymous session BEFORE this
// gate runs (in middleware or the root layout). That gives them a profile, so `getOnboardingState`
// returns { hasUser: true, completed: false } and the existing "/" redirect catches them — no change
// needed here. Suggested shape for that future step:
//
//   // middleware.ts (future):
//   //   const { data: { user } } = await supabase.auth.getUser()
//   //   if (!user) await supabase.auth.signInAnonymously()  // sets cookie on the response
//
// Keep that bootstrap OUTSIDE this module so the gate stays a pure read.
