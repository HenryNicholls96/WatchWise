import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/types/logger'
import {
  __resetReporterForTests,
  __setReporterForTests,
  captureException,
  captureMessage,
  initErrorReporting,
  isErrorReportingEnabled,
} from '@/lib/utils/error-reporting'

const noop: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function fakeReporter() {
  return { captureException: vi.fn(), captureMessage: vi.fn() }
}

beforeEach(() => __resetReporterForTests())
afterEach(() => {
  __resetReporterForTests()
  vi.unstubAllEnvs()
})

describe('captureException / captureMessage — no-op until configured', () => {
  it('does nothing and never throws when no reporter is configured', () => {
    expect(isErrorReportingEnabled()).toBe(false)
    expect(() => captureException(new Error('boom'), { route: 'r' })).not.toThrow()
    expect(() => captureMessage('hello')).not.toThrow()
  })
})

describe('captureException — forwarding + context mapping', () => {
  it('forwards the error and maps context to Sentry tags/extra/user', () => {
    const r = fakeReporter()
    __setReporterForTests(r)
    const err = new Error('upstream down')

    captureException(err, {
      route: 'POST /api/recommendations',
      requestId: 'req-1',
      journeyId: 'j-1',
      subject: 'user-123',
      errorCode: 'EMBEDDING_FAILED',
      flags: { explanations_llm: false },
    })

    expect(r.captureException).toHaveBeenCalledTimes(1)
    const [reported, ctx] = r.captureException.mock.calls[0]
    expect(reported).toBe(err)
    expect(ctx).toMatchObject({
      tags: { route: 'POST /api/recommendations', errorCode: 'EMBEDDING_FAILED' },
      extra: { requestId: 'req-1', journeyId: 'j-1', flags: { explanations_llm: false } },
      user: { id: 'user-123' },
    })
  })

  it('omits empty context sections', () => {
    const r = fakeReporter()
    __setReporterForTests(r)
    captureException(new Error('x'))
    expect(r.captureException.mock.calls[0][1]).toEqual({}) // no tags/extra/user when nothing supplied
  })

  it('never throws even if the underlying reporter throws', () => {
    __setReporterForTests({
      captureException: vi.fn(() => {
        throw new Error('sentry exploded')
      }),
      captureMessage: vi.fn(),
    })
    expect(() => captureException(new Error('x'), { route: 'r' })).not.toThrow()
  })
})

describe('captureMessage', () => {
  it('forwards with a default info level', () => {
    const r = fakeReporter()
    __setReporterForTests(r)
    captureMessage('heads up', { route: 'r' })
    expect(r.captureMessage).toHaveBeenCalledWith('heads up', expect.objectContaining({ level: 'info', tags: { route: 'r' } }))
  })
})

describe('initErrorReporting — fail-open without a DSN', () => {
  it('stays disabled (no-op) when SENTRY_DSN is unset and does not throw', async () => {
    __resetReporterForTests()
    // SENTRY_DSN unset in the test env → must not attempt to load/init Sentry.
    await expect(initErrorReporting({ logger: noop })).resolves.toBeUndefined()
    expect(isErrorReportingEnabled()).toBe(false)
  })
})
