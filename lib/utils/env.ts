// Environment-variable access helpers.

/** Reads a required env var, throwing a clear error if it is missing or empty. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
