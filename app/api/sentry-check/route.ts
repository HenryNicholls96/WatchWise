// TEMPORARY — Sentry capture verification probe. Delete after confirming an event lands in Sentry.
//
// Explicitly exercises the error-reporting facade (initialized from instrumentation.ts when SENTRY_DSN is set)
// so we can prove end-to-end capture. Returns whether reporting is active for instant feedback; the captured
// event should appear in Sentry tagged with the current release and environment.

import { NextResponse } from 'next/server'
import {
  captureException,
  initErrorReporting,
  isErrorReportingEnabled,
} from '@/lib/utils/error-reporting'
import { getCurrentRelease } from '@/lib/utils/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  // Ensure this module instance is initialized (idempotent); covers the case where instrumentation ran in a
  // different bundle than this route handler.
  await initErrorReporting()

  const error = new Error('WatchWise Sentry verification probe — safe to ignore')
  captureException(error, {
    route: 'GET /api/sentry-check',
    errorCode: 'SENTRY_VERIFICATION',
    level: 'error',
  })

  return NextResponse.json(
    {
      sentEvent: true,
      reportingEnabled: isErrorReportingEnabled(),
      dsnPresent: Boolean(process.env.SENTRY_DSN),
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? null,
      release: getCurrentRelease(),
      timestamp: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } }
  )
}
