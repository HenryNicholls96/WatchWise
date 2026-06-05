// Minimal structured logger contract used across the recommendation engine.
// Injected everywhere so core logic never touches console directly — tests pass a spy,
// production passes a real logger, and a no-op default keeps call sites clean.

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

/** Discards all log output. Default for callers that do not supply a logger. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Simple console-backed logger for CLI scripts. Meta is appended as JSON when present. */
export const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(fmt(m, meta)),
  info: (m, meta) => console.log(fmt(m, meta)),
  warn: (m, meta) => console.warn(fmt(m, meta)),
  error: (m, meta) => console.error(fmt(m, meta)),
}

function fmt(msg: string, meta?: Record<string, unknown>): string {
  return meta && Object.keys(meta).length > 0 ? `${msg} ${JSON.stringify(meta)}` : msg
}
