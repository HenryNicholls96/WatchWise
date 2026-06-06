// Server-evaluated feature flags — kill switches + gradual (percentage) rollouts.
//
// Design (deliberately small, see docs/deployment-and-rollouts.md §3):
//   • SERVER-ONLY. Flags are evaluated on the server and never serialized to the client — there is no
//     flag value in any HTTP response, so the UI can't flicker and a flag can't leak.
//   • FAIL-OPEN. Every path degrades to the flag's declared `defaultEnabled` (a kill switch defaults ON so
//     an outage keeps the feature working; a gradual-rollout flag defaults OFF so an outage stays safe).
//     A store error or a bad value never throws and never blocks a request.
//   • Built on the existing DistributedStore (Upstash/InMemory). A runtime override lives at `flag:<name>`
//     so a flag can be flipped or ramped WITHOUT a redeploy. Reads are amortized by a short in-process TTL
//     cache so evaluation stays cheap (≈ no I/O on the hot path between refreshes).
//
// Precedence (highest first):  env override (FLAG_<NAME>)  >  store override (flag:<name>)  >  registry default.
//
// Adding a flag: add one entry to FLAG_REGISTRY below, then call isFeatureEnabled('<name>', subject?) from
// any server code (API route OR the recommendation engine — it has no route-only dependencies).

import { createHash } from 'node:crypto'
import { type Logger, consoleLogger } from '@/lib/types/logger'
import { type DistributedStore, getDistributedStore } from '@/lib/utils/distributed-store'

// ─── Registry ───────────────────────────────────────────────────────────────────

export type FlagDefinition = {
  /** One-line description of what the flag controls (shown by listFlags). */
  description: string
  /** Value used when nothing overrides it, and the fail-open value on any error. */
  defaultEnabled: boolean
  /** Optional default rollout percentage (0–100). A store override can change it without a redeploy. */
  rollout?: number
}

// The single source of truth. Keys are flag names (lower_snake_case → env var FLAG_<UPPER_SNAKE>).
export const FLAG_REGISTRY = {
  explanations_llm: {
    description:
      'Use Claude Haiku for "why this" explanations. Off → deterministic fallbacks only (cost/incident kill switch).',
    defaultEnabled: true,
  },
} satisfies Record<string, FlagDefinition>

export type FlagName = keyof typeof FLAG_REGISTRY

/** Runtime override stored at `flag:<name>` — flip (`enabled`) or ramp (`rollout`) without a redeploy. */
export type FlagOverride = { enabled?: boolean; rollout?: number }

export type FlagDeps = {
  /** Defaults to the process-wide DistributedStore singleton. Injecting a store BYPASSES the cache (tests). */
  store?: DistributedStore
  logger?: Logger
  /** Injectable clock for cache-TTL tests. */
  now?: () => number
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

// Short TTL keeps evaluation cheap (store read at most once per flag per window) while still letting a
// runtime flip/ramp take effect within seconds.
const CACHE_TTL_MS = Number(process.env.FLAG_CACHE_TTL_MS) || 30_000

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled'])
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled'])

// ─── Pure evaluation core (no I/O — fully unit-testable) ────────────────────────

/** Stable 0–99 bucket for (flag, subject). Deterministic, ~uniform — same inputs always map to the same bucket. */
export function bucketFor(name: string, subject: string): number {
  return createHash('sha256').update(`${name}:${subject}`).digest().readUInt32BE(0) % 100
}

/**
 * Resolves a flag from its inputs. Precedence: env > store override > registry default.
 * `enabled` is the master switch; `rollout` (when set, and only while enabled) gates by deterministic
 * bucketing. A percentage rollout with no subject resolves to false (we can't bucket without a stable id).
 */
export function resolveFlag(args: {
  name: string
  definition: FlagDefinition
  override: FlagOverride | null
  envValue: boolean | undefined
  subject?: string
}): boolean {
  const { name, definition, override, envValue, subject } = args
  if (envValue !== undefined) return envValue // env kill switch wins outright

  const enabled = override?.enabled ?? definition.defaultEnabled
  if (!enabled) return false

  const rollout = override?.rollout ?? definition.rollout
  if (rollout === undefined) return true
  if (rollout >= 100) return true
  if (rollout <= 0) return false
  if (subject === undefined) return false
  return bucketFor(name, subject) < rollout
}

/** Reads + validates FLAG_<NAME> from the environment. Unknown/garbage values are ignored (→ undefined). */
export function parseEnvOverride(name: string, env: Record<string, string | undefined> = process.env): boolean | undefined {
  const raw = env[`FLAG_${name.toUpperCase()}`]
  if (raw == null) return undefined
  const v = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(v)) return true
  if (FALSE_VALUES.has(v)) return false
  return undefined
}

// ─── Store-backed evaluation ────────────────────────────────────────────────────

const overrideCache = new Map<string, { value: FlagOverride | null; expiresAt: number }>()

function coerceOverride(raw: unknown): FlagOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const out: FlagOverride = {}
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.rollout === 'number' && Number.isFinite(o.rollout)) out.rollout = Math.max(0, Math.min(100, o.rollout))
  return out
}

async function readOverride(name: string, deps: FlagDeps): Promise<FlagOverride | null> {
  const logger = deps.logger ?? consoleLogger
  const now = deps.now ?? Date.now
  const useCache = !deps.store // an injected store (tests) reads fresh; production uses the singleton + cache
  const store = deps.store ?? getDistributedStore()

  if (useCache) {
    const cached = overrideCache.get(name)
    if (cached && cached.expiresAt > now()) return cached.value
  }
  try {
    const value = coerceOverride(await store.getJson<unknown>(`flag:${name}`))
    if (useCache) overrideCache.set(name, { value, expiresAt: now() + CACHE_TTL_MS })
    return value
  } catch (err) {
    logger.warn('feature flag override read failed (fail-open to default)', {
      flag: name,
      message: err instanceof Error ? err.message : String(err),
    })
    if (useCache) overrideCache.set(name, { value: null, expiresAt: now() + CACHE_TTL_MS }) // don't hammer a down store
    return null
  }
}

/**
 * Whether `flag` is enabled for `subject` (a stable id — userId, or `ip:<ip>` for anon). `subject` is only
 * needed for percentage rollouts; boolean flags ignore it. Never throws — fail-open to the registry default.
 */
export async function isFeatureEnabled(flag: FlagName, subject?: string, deps: FlagDeps = {}): Promise<boolean> {
  const definition = FLAG_REGISTRY[flag]
  if (!definition) {
    ;(deps.logger ?? consoleLogger).warn('unknown feature flag — treating as disabled', { flag })
    return false
  }
  // Env kill switch short-circuits before any I/O.
  const envValue = parseEnvOverride(flag)
  if (envValue !== undefined) return envValue

  const override = await readOverride(flag, deps)
  return resolveFlag({ name: flag, definition, override, envValue: undefined, subject })
}

/**
 * Resolves EVERY registered flag for `subject`, as `{ [name]: enabled }`. Used to stamp the active flag set
 * onto observability events. Cheap (each eval hits the in-process cache) and fail-open (isFeatureEnabled
 * never throws), so it's safe to call once per request.
 */
export async function evaluateAllFlags(subject?: string, deps: FlagDeps = {}): Promise<Record<FlagName, boolean>> {
  const names = Object.keys(FLAG_REGISTRY) as FlagName[]
  const entries = await Promise.all(names.map(async (name) => [name, await isFeatureEnabled(name, subject, deps)] as const))
  return Object.fromEntries(entries) as Record<FlagName, boolean>
}

/** All known flags + their resolved env var name. For tooling / a future flags admin / observability stamping. */
export function listFlags(): Array<FlagDefinition & { name: FlagName; envVar: string }> {
  return (Object.keys(FLAG_REGISTRY) as FlagName[]).map((name) => ({
    name,
    envVar: `FLAG_${name.toUpperCase()}`,
    ...FLAG_REGISTRY[name],
  }))
}

/** Test helper — clears the in-process override cache so a test's store/env state is read fresh. */
export function __resetFlagCacheForTests(): void {
  overrideCache.clear()
}
