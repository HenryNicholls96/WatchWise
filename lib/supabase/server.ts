// Server-side Supabase client — for API routes, Server Components, and server actions.
//
// Cookie-aware (via @supabase/ssr) so auth/session state is read from and written to the request's
// cookies. createClient() is async because Next.js 15's `cookies()` returns a Promise. When a
// generated `Database` type lands, add it as the generic: createServerClient<Database>(...).

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { requireEnv } from '@/lib/utils/env'

/**
 * Creates a request-scoped Supabase client bound to the current cookie store.
 * Use inside route handlers, Server Components, and server actions.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          // Server Components can't set cookies; this throws there and is safely ignored — session
          // refresh is handled by middleware. In route handlers / actions the writes take effect.
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // no-op: called from a Server Component render
          }
        },
      },
    }
  )
}
