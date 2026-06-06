// Browser-side Supabase client — for Client Components ('use client').
//
// Backed by @supabase/ssr's createBrowserClient, which reads the session from cookies set by the
// server client so auth state stays in sync across the boundary. Only the public anon key is used
// here (NEXT_PUBLIC_*); never reference the service role key in browser-reachable code. When a
// generated `Database` type lands, add it as the generic: createBrowserClient<Database>(...).

import { createBrowserClient } from '@supabase/ssr'

// NOTE: these MUST be referenced as static `process.env.NEXT_PUBLIC_*` literals — Next.js only inlines
// public env vars into the client bundle for literal keys, so a dynamic lookup (requireEnv) reads
// undefined in the browser. (The server client can use the dynamic helper; the browser cannot.)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

/** Creates a Supabase client for use in Client Components. */
export function createClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}
