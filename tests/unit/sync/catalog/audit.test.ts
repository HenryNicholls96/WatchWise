import { describe, expect, it, vi } from 'vitest'
import { type AuditSampleItem, computeVerdict, runAudit } from '@/lib/sync/catalog/audit'

describe('computeVerdict', () => {
  it('pass when every layer is healthy', () => {
    expect(computeVerdict(1, 1, 0)).toBe('pass')
    expect(computeVerdict(0.99, 0.98, 0.05)).toBe('pass')
  })
  it('needs_review when a layer is in the warn band', () => {
    expect(computeVerdict(0.95, 1, 0)).toBe('needs_review') // internal between 0.9 and 0.99
    expect(computeVerdict(1, 1, 0.1)).toBe('needs_review') // cross-source disagreement 0.05–0.15
  })
  it('fail when any layer is below the hard floor', () => {
    expect(computeVerdict(0.5, 1, 0)).toBe('fail')
    expect(computeVerdict(1, 1, 0.5)).toBe('fail')
  })
  it('treats null (nothing checkable) as non-penalizing', () => {
    expect(computeVerdict(null, null, null)).toBe('pass')
  })
})

const item = (over: Partial<AuditSampleItem> = {}): AuditSampleItem => ({
  motnId: '1',
  tmdbId: 100,
  type: 'movie',
  title: 'T',
  deepLink: 'https://bbc/x',
  ...over,
})

describe('runAudit', () => {
  it('aggregates layers into a pass when all checks succeed', async () => {
    const report = await runAudit([item(), item({ motnId: '2', tmdbId: 200 })], {
      requeryConsistent: vi.fn().mockResolvedValue(true),
      checkLink: vi.fn().mockResolvedValue(true),
      crossCheck: vi.fn().mockResolvedValue(true),
    })
    expect(report.verdict).toBe('pass')
    expect(report.internalConsistency).toMatchObject({ checked: 2, passed: 2 })
    expect(report.deepLinkLiveness).toMatchObject({ checked: 2, passed: 2 })
    expect(report.crossSource).toMatchObject({ checked: 2, passed: 2 })
  })

  it('hard-fails when internal consistency collapses (a write/mapping bug)', async () => {
    const report = await runAudit([item(), item({ motnId: '2' }), item({ motnId: '3' }), item({ motnId: '4' })], {
      requeryConsistent: vi.fn().mockResolvedValue(false), // 0% match
      checkLink: vi.fn().mockResolvedValue(true),
      crossCheck: vi.fn().mockResolvedValue(null),
    })
    expect(report.verdict).toBe('fail')
    expect(report.internalConsistency.failures).toHaveLength(4)
  })

  it('skips cross-source for titles without a tmdbId (no false disagreement)', async () => {
    const report = await runAudit([item({ tmdbId: null })], {
      requeryConsistent: vi.fn().mockResolvedValue(true),
      checkLink: vi.fn().mockResolvedValue(true),
      crossCheck: vi.fn().mockResolvedValue(true),
    })
    expect(report.crossSource.checked).toBe(0)
    expect(report.verdict).toBe('pass')
  })
})
