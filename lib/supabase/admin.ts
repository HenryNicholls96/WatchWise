// Service-role Supabase client — SERVER-ONLY, never import from a Client Component.
//
// Bypasses RLS, so it's used narrowly for non-user, server-managed data (currently the shared
// explanation_cache, which has no public policies). Returns null when the service key is absent so
// callers can fail open. Module-level singleton — reused across requests within an instance.

// Hard build-time guard: importing this module into a Client Component throws, so the service key can
// never be bundled for the browser (belt-and-braces alongside the non-NEXT_PUBLIC_ env-var name).
import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null | undefined

export function createServiceRoleClient(): SupabaseClient | null {
  if (cached !== undefined) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    cached = null
    return null
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
