// Trusted client-IP extraction for rate limiting.
//
// We must NOT trust the left-most `x-forwarded-for` value: it is set by the caller and trivially
// spoofable, so keying a per-IP limit on it lets an attacker mint unlimited buckets. We instead
// prefer headers the platform sets itself (Vercel overrides these and a client cannot forge them),
// and only fall back to the RIGHT-MOST x-forwarded-for hop (the one our trusted proxy appended).

/** Resolve the client IP from a header getter. Returns a stable 'local' bucket off-platform/in dev. */
export function clientIpFromHeaders(getHeader: (name: string) => string | null): string {
  // Vercel-set, non-forgeable. (x-vercel-forwarded-for is a single trusted value.)
  const vercel = getHeader('x-vercel-forwarded-for')
  if (vercel) return vercel.split(',')[0]!.trim()

  const realIp = getHeader('x-real-ip')
  if (realIp) return realIp.trim()

  // Generic reverse proxies: the right-most hop was appended by our infra; the left-most is the
  // (untrusted) client-supplied value, so we deliberately ignore it.
  const fwd = getHeader('x-forwarded-for')
  if (fwd) {
    const hops = fwd
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    if (hops.length > 0) return hops[hops.length - 1]!
  }

  return 'local'
}
