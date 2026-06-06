// Next.js instrumentation hook — runs once per server runtime at startup.
//
// We use it to initialize error reporting (Sentry, when SENTRY_DSN is set). Once Sentry is initialized its
// own global handlers also capture unhandled exceptions and unhandled promise rejections. We init only in
// the Node runtime (our API routes are `runtime = 'nodejs'`); the edge runtime is skipped to stay lean.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return
  const { initErrorReporting } = await import('@/lib/utils/error-reporting')
  await initErrorReporting()
}

// Called by Next for errors thrown during the request lifecycle (rendering / route handlers) that aren't
// otherwise handled. Forwards them to the reporter with light request context. Fail-open by construction
// (captureException never throws).
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
): Promise<void> {
  const { captureException } = await import('@/lib/utils/error-reporting')
  const route = request?.path ? `${request.method ?? ''} ${request.path}`.trim() : undefined
  captureException(error, { route, errorCode: 'UNHANDLED_REQUEST_ERROR' })
}
