import { describe, expect, it } from 'vitest'
import { clientIpFromHeaders } from '@/lib/utils/client-ip'

function headers(map: Record<string, string>): (name: string) => string | null {
  return (name) => map[name] ?? null
}

describe('clientIpFromHeaders', () => {
  it('prefers the Vercel trusted header', () => {
    const get = headers({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-forwarded-for': '9.9.9.9, 203.0.113.7', // spoofed left-most ignored
      'x-real-ip': '198.51.100.1',
    })
    expect(clientIpFromHeaders(get)).toBe('203.0.113.7')
  })

  it('uses x-real-ip when no Vercel header', () => {
    expect(clientIpFromHeaders(headers({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1')
  })

  it('uses the RIGHT-MOST x-forwarded-for hop, ignoring a spoofed left-most value', () => {
    // Attacker injects "9.9.9.9" as the left-most; our proxy appends the real "203.0.113.7" last.
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('handles a single x-forwarded-for value', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('falls back to a stable bucket with no proxy headers (local/dev)', () => {
    expect(clientIpFromHeaders(headers({}))).toBe('local')
  })

  it('does NOT return the spoofable left-most value', () => {
    const ip = clientIpFromHeaders(headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))
    expect(ip).not.toBe('1.1.1.1')
    expect(ip).toBe('2.2.2.2')
  })
})
