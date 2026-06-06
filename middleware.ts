// Edge middleware — bootstraps an anonymous Supabase session for brand-new visitors BEFORE the
// onboarding gate (app/page.tsx → getOnboardingState) runs. This is the activation step the gate's
// own design note describes: once a visitor has a session, getOnboardingState returns
// { hasUser: true, completed: false } and the existing "/" → "/onboarding" redirect funnels them in.
//
// Kept entirely outside the gate so the gate stays a pure read. Fail-open: if anonymous sign-in is
// disabled or the auth call errors, we pass the request through untouched (visitor simply isn't
// auto-routed — nothing breaks).
//
// Scope (see `config.matcher`): page navigations only. API routes are deliberately EXCLUDED so we
// never mint a session for an anonymous /api/recommendations caller — that path relies on IP-based
// rate limiting and a session-less identity, which this bootstrap must not change.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return response

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        // Mirror new cookies onto BOTH the request (so the page render in this same pass sees the
        // fresh session) and the response (so the browser persists it).
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
      },
    },
  })

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    // No session yet → mint an anonymous one (setAll above writes the cookies onto `response`).
    if (!user) await supabase.auth.signInAnonymously()
  } catch {
    // Fail-open: anonymous sign-in unavailable/disabled — leave the visitor session-less and unrouted.
  }

  return response
}

export const config = {
  // Run on page routes only; skip API, Next internals, and static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
