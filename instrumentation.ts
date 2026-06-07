// Next.js instrumentation hook — runs once per server runtime at startup.
//
// We use it to initialize error reporting (Sentry, when SENTRY_DSN is set). Once Sentry is initialized its
// own global handlers also capture unhandled exceptions and unhandled promise rejections.
//
// IMPORTANT: the error-reporting module pulls in Node-only code (@sentry/node, node:crypto). Next compiles
// this file for EVERY runtime, including Edge — so the import MUST sit inside a `NEXT_RUNTIME === 'nodejs'`
// guard. Next uses that exact check to exclude the dynamic import from the Edge bundle; without it, Next
// validates the Node-only chain against the Edge runtime and the build fails. Our API routes are all
// `runtime = 'nodejs'`, so Node-only error reporting is exactly what we want.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initErrorReporting } = await import('@/lib/utils/error-reporting')
    await initErrorReporting()
  }
}

// Called by Next for errors thrown during the request lifecycle (rendering / route handlers) that aren't
// otherwise handled. Forwards them to the reporter with light request context. Node runtime only (same
// reason as above); fail-open by construction (captureException never throws).
export async function onRequestError(error: unknown, request: { path?: string; method?: string }): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { captureException, flushErrorReporting } = await import('@/lib/utils/error-reporting')
    const route = request?.path ? `${request.method ?? ''} ${request.path}`.trim() : undefined
    captureException(error, { route, errorCode: 'UNHANDLED_REQUEST_ERROR' })
    // Serverless freezes the instance after the response; flush so the event isn't lost.
    await flushErrorReporting()
  }
}
