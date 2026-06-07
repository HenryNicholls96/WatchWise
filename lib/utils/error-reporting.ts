// Error reporting — a thin, FAIL-OPEN facade over Sentry.
//
// Goals (lean, see docs/deployment-and-rollouts.md): visibility into UNEXPECTED errors before launch, not a
// full observability platform. So: errors only (no tracing/perf), server-side only, and nothing here may
// ever throw or block a request.
//
// Sentry is loaded LAZILY via dynamic import and ONLY when SENTRY_DSN is set. With no DSN (local dev, CI,
// tests) the facade is an inert no-op and @sentry/nextjs is never even imported — so the hot path, the test
// suite, and the production build are all unaffected until a DSN is configured. Init is wired from
// instrumentation.ts (server startup); Sentry's own global handlers then also catch unhandled exceptions /
// promise rejections. Errors are tied to the current release via getCurrentRelease().

import { type Logger, consoleLogger } from '@/lib/types/logger'
import { getCurrentRelease } from '@/lib/utils/observability'

/** Context attached to a captured event. All optional — pass what's cheaply available at the call site. */
export type ErrorContext = {
  /** e.g. 'POST /api/recommendations'. */
  route?: string
  requestId?: string
  /** Correlates with the structured observability events. */
  journeyId?: string
  /** userId, or `ip:<ip>` for anonymous callers — becomes the Sentry user id. */
  subject?: string
  errorCode?: string
  flags?: Record<string, boolean>
  level?: 'error' | 'warning' | 'info'
}

// Shape we pass to Sentry (a Partial<ScopeContext>). Kept local so the rest of the app never imports Sentry.
type SentryContext = {
  level?: 'error' | 'warning' | 'info'
  tags?: Record<string, string>
  extra?: Record<string, unknown>
  user?: { id: string }
}

// Our minimal reporter seam. The real one wraps Sentry; tests inject a fake. Holding our own type (not the
// Sentry module) keeps the facade decoupled and trivially mockable.
type Reporter = {
  captureException(error: unknown, context: SentryContext): void
  captureMessage(message: string, context: SentryContext): void
  flush?(timeoutMs: number): Promise<boolean>
}

let reporter: Reporter | null = null
let initialized = false

function toSentryContext(c: ErrorContext): SentryContext {
  const tags: Record<string, string> = {}
  if (c.route) tags.route = c.route
  if (c.errorCode) tags.errorCode = c.errorCode

  const extra: Record<string, unknown> = {}
  if (c.requestId) extra.requestId = c.requestId
  if (c.journeyId) extra.journeyId = c.journeyId
  if (c.flags) extra.flags = c.flags

  const ctx: SentryContext = {}
  if (Object.keys(tags).length > 0) ctx.tags = tags
  if (Object.keys(extra).length > 0) ctx.extra = extra
  if (c.subject) ctx.user = { id: c.subject }
  if (c.level) ctx.level = c.level
  return ctx
}

/**
 * Initializes error reporting once, on server startup (from instrumentation.ts). No-op without SENTRY_DSN.
 * Fail-open: if the SDK can't load or init, we log and continue with reporting disabled. Errors are tagged
 * with the current release so regressions can be tied to a deploy.
 */
export async function initErrorReporting(deps: { logger?: Logger } = {}): Promise<void> {
  if (initialized) return
  initialized = true
  const logger = deps.logger ?? consoleLogger

  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    logger.debug('error reporting: SENTRY_DSN not set — running without it')
    return
  }

  try {
    // The Node SDK exposes a stable init/captureException/captureMessage in the Vercel Node runtime our
    // routes use. (@sentry/nextjs has runtime-conditional exports that aren't reliable outside Next's
    // bundler; it's kept as a dep for the documented source-map/withSentryConfig path — see the rollout doc.)
    const Sentry = await import('@sentry/node')
    Sentry.init({
      dsn,
      release: getCurrentRelease(),
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
      // Errors only — no performance tracing/profiling (kept lean, also keeps cost/volume down).
      tracesSampleRate: 0,
      sendDefaultPii: false,
    })
    reporter = {
      captureException: (error, ctx) => {
        Sentry.captureException(error, ctx)
      },
      captureMessage: (message, ctx) => {
        Sentry.captureMessage(message, ctx)
      },
      flush: (timeoutMs) => Sentry.flush(timeoutMs),
    }
    logger.info('error reporting initialized (sentry)', { release: getCurrentRelease() })
  } catch (err) {
    logger.warn('error reporting init failed — continuing without it (fail-open)', {
      message: err instanceof Error ? err.message : String(err),
    })
    reporter = null
  }
}

/** Reports an exception. Safe to call anywhere, anytime — no-op until initialized, and never throws. */
export function captureException(error: unknown, context: ErrorContext = {}): void {
  try {
    reporter?.captureException(error, toSentryContext(context))
  } catch {
    // An error-reporter failure must never affect the request.
  }
}

/** Reports a message (defaults to info level). Same fail-open guarantees as captureException. */
export function captureMessage(message: string, context: ErrorContext = {}): void {
  try {
    reporter?.captureMessage(message, { level: 'info', ...toSentryContext(context) })
  } catch {
    // no-op
  }
}

/**
 * Flushes buffered events to Sentry. REQUIRED before a serverless function returns: the SDK ships events
 * asynchronously, and Vercel freezes the instance after the response — un-flushed events are lost. No-op (and
 * resolves false) when reporting is disabled. Never throws.
 */
export async function flushErrorReporting(timeoutMs = 2_000): Promise<boolean> {
  try {
    return (await reporter?.flush?.(timeoutMs)) ?? false
  } catch {
    return false
  }
}

/** Whether error reporting is active (a DSN was configured and the SDK initialized). */
export function isErrorReportingEnabled(): boolean {
  return reporter !== null
}

// ─── test seams ─────────────────────────────────────────────────────────────────

/** Inject a fake reporter (and mark initialized) so capture wiring can be asserted without Sentry. */
export function __setReporterForTests(fake: Reporter | null): void {
  reporter = fake
  initialized = true
}

/** Reset to the uninitialized no-op state between tests. */
export function __resetReporterForTests(): void {
  reporter = null
  initialized = false
}
