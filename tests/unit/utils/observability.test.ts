import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/types/logger'
import {
  __resetReleaseCacheForTests,
  emitExplanationMetrics,
  emitRecommendationMetrics,
  getCurrentRelease,
  makeJourneyId,
  resolveRelease,
  startTimer,
  type ExplanationRequestMetrics,
  type RecommendationMetrics,
  type RecommendationPipelineMetrics,
} from '@/lib/utils/observability'

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function pipeline(over: Partial<RecommendationPipelineMetrics> = {}): RecommendationPipelineMetrics {
  return {
    stages: { retrieveMs: 5, filterMs: 2, scoreMs: 1, explainMs: 40, offersMs: 8 },
    explanation: { cacheHits: 5, cacheMisses: 3, llmUsed: true, fallbackCount: 0, deadlineHit: false, llmError: false, llmRetries: 0, breakerOpen: false },
    funnel: { retrieved: 100, filtered: 42, returned: 8, zeroResult: false, genreExclusionsRelaxed: false },
    blendedCoverage: 1,
    ...over,
  }
}

function okMetrics(over: Partial<RecommendationMetrics> = {}): RecommendationMetrics {
  return { event: 'recommendation_request', requestId: 'req-1', journeyId: 'j-1', outcome: 'ok', totalMs: 120, pipeline: pipeline(), ...over }
}

describe('startTimer', () => {
  it('returns a non-negative elapsed-ms reader', () => {
    const elapsed = startTimer()
    expect(elapsed()).toBeGreaterThanOrEqual(0)
  })
})

describe('emitRecommendationMetrics', () => {
  it('logs a successful request at info with the full event as meta', () => {
    const logger = spyLogger()
    emitRecommendationMetrics(logger, okMetrics())

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    const [msg, meta] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(msg).toBe('recommendation_request')
    expect(meta).toMatchObject({ requestId: 'req-1', outcome: 'ok' })
  })

  it('elevates an error outcome to warn (and carries the errorCode, no pipeline)', () => {
    const logger = spyLogger()
    emitRecommendationMetrics(logger, {
      event: 'recommendation_request',
      requestId: 'req-err',
      journeyId: '',
      outcome: 'error',
      errorCode: 'TASTE_LOAD_FAILED',
      totalMs: 30,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalled()
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      outcome: 'error',
      errorCode: 'TASTE_LOAD_FAILED',
    })
  })

  it('elevates a zero-result run to warn even when the outcome is ok', () => {
    const logger = spyLogger()
    emitRecommendationMetrics(logger, okMetrics({ pipeline: pipeline({ funnel: { ...pipeline().funnel, returned: 0, zeroResult: true } }) }))

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('is fail-open: never throws even when the logger throws', () => {
    const throwing: Logger = {
      debug: vi.fn(),
      info: vi.fn(() => {
        throw new Error('log sink down')
      }),
      warn: vi.fn(() => {
        throw new Error('log sink down')
      }),
      error: vi.fn(),
    }
    expect(() => emitRecommendationMetrics(throwing, okMetrics())).not.toThrow()
    expect(() => emitRecommendationMetrics(throwing, okMetrics({ outcome: 'error', pipeline: undefined }))).not.toThrow()
  })
})

describe('resolveRelease', () => {
  it('prefers VERCEL_GIT_COMMIT_SHA and shortens a 40-char SHA to 7', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01'
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: sha })).toBe('abcdef0')
  })

  it('falls back RELEASE → GIT_COMMIT_SHA → "unknown" and preserves non-SHA values', () => {
    expect(resolveRelease({ RELEASE: 'v1.2.3' })).toBe('v1.2.3')
    expect(resolveRelease({ GIT_COMMIT_SHA: 'deadbeef' })).toBe('deadbeef') // not 40 hex → passed through
    expect(resolveRelease({})).toBe('unknown')
    expect(resolveRelease({ RELEASE: '   ' })).toBe('unknown')
  })

  it('precedence: VERCEL_GIT_COMMIT_SHA wins over RELEASE', () => {
    const sha = 'a'.repeat(40)
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: sha, RELEASE: 'v9' })).toBe('aaaaaaa')
  })
})

describe('getCurrentRelease', () => {
  it('memoizes a single resolution (immutable per deploy)', () => {
    __resetReleaseCacheForTests()
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'feedface00000000000000000000000000000000')
    const first = getCurrentRelease()
    expect(first).toBe('feedfac')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'ffffffffffffffffffffffffffffffffffffffff') // changed after first read
    expect(getCurrentRelease()).toBe(first) // still memoized
    vi.unstubAllEnvs()
    __resetReleaseCacheForTests()
  })
})

describe('makeJourneyId', () => {
  it('is deterministic for the same caller + query (so a journey correlates across endpoints)', () => {
    expect(makeJourneyId('user-1', 'qhash')).toBe(makeJourneyId('user-1', 'qhash'))
  })

  it('differs when the caller or query differs', () => {
    expect(makeJourneyId('user-1', 'qhash')).not.toBe(makeJourneyId('user-2', 'qhash'))
    expect(makeJourneyId('user-1', 'qhash')).not.toBe(makeJourneyId('user-1', 'other'))
  })
})

describe('emitExplanationMetrics', () => {
  function explMetrics(over: Partial<ExplanationRequestMetrics> = {}): ExplanationRequestMetrics {
    return {
      event: 'explanation_request',
      requestId: 'req-1',
      journeyId: 'j-1',
      outcome: 'ok',
      totalMs: 50,
      requested: 8,
      explained: 8,
      explanation: { cacheHits: 0, cacheMisses: 8, llmUsed: true, fallbackCount: 5, deadlineHit: true, llmError: false, llmRetries: 1, breakerOpen: false },
      ...over,
    }
  }

  it('logs ok at info and error at warn, carrying the journeyId', () => {
    const logger = spyLogger()
    emitExplanationMetrics(logger, explMetrics())
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ journeyId: 'j-1', requested: 8 })

    emitExplanationMetrics(logger, explMetrics({ outcome: 'error', errorCode: 'RATE_LIMITED' }))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ errorCode: 'RATE_LIMITED' })
  })

  it('is fail-open: never throws when the logger throws', () => {
    const throwing: Logger = {
      debug: vi.fn(),
      info: vi.fn(() => { throw new Error('down') }),
      warn: vi.fn(() => { throw new Error('down') }),
      error: vi.fn(),
    }
    expect(() => emitExplanationMetrics(throwing, explMetrics())).not.toThrow()
  })
})
