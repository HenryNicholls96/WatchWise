import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/types/logger'
import { InMemoryStore } from '@/lib/utils/distributed-store'
import {
  type FlagName,
  FLAG_REGISTRY,
  __resetFlagCacheForTests,
  bucketFor,
  evaluateAllFlags,
  isFeatureEnabled,
  listFlags,
  parseEnvOverride,
  resolveFlag,
} from '@/lib/flags'

const noop: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// A real registered flag (kill switch, defaults ON) to exercise the public API against.
const FLAG: FlagName = 'explanations_llm'
const DEF = FLAG_REGISTRY[FLAG]

function freshDeps() {
  return { store: new InMemoryStore(), logger: noop }
}

beforeEach(() => {
  __resetFlagCacheForTests()
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

describe('parseEnvOverride', () => {
  it('parses truthy/falsy values and ignores garbage/missing', () => {
    const env = (v?: string) => (v === undefined ? {} : { FLAG_EXPLANATIONS_LLM: v })
    expect(parseEnvOverride(FLAG, env('on'))).toBe(true)
    expect(parseEnvOverride(FLAG, env('TRUE'))).toBe(true)
    expect(parseEnvOverride(FLAG, env('0'))).toBe(false)
    expect(parseEnvOverride(FLAG, env('off'))).toBe(false)
    expect(parseEnvOverride(FLAG, env('maybe'))).toBeUndefined()
    expect(parseEnvOverride(FLAG, env())).toBeUndefined()
  })
})

describe('bucketFor', () => {
  it('is deterministic and within [0,100)', () => {
    for (const s of ['user-1', 'user-2', 'ip:1.2.3.4']) {
      const b = bucketFor(FLAG, s)
      expect(b).toBe(bucketFor(FLAG, s)) // stable
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(100)
    }
  })

  it('spreads ~uniformly so a percentage rollout is roughly accurate', () => {
    let inRollout = 0
    const N = 2000
    for (let i = 0; i < N; i++) if (bucketFor(FLAG, `user-${i}`) < 50) inRollout++
    expect(inRollout / N).toBeGreaterThan(0.45)
    expect(inRollout / N).toBeLessThan(0.55)
  })
})

describe('resolveFlag (pure precedence)', () => {
  it('env override wins over store and registry', () => {
    expect(resolveFlag({ name: FLAG, definition: DEF, override: { enabled: false }, envValue: true })).toBe(true)
    expect(resolveFlag({ name: FLAG, definition: { description: '', defaultEnabled: true }, override: null, envValue: false })).toBe(false)
  })

  it('store override wins over registry default', () => {
    const def = { description: '', defaultEnabled: true }
    expect(resolveFlag({ name: FLAG, definition: def, override: { enabled: false }, envValue: undefined })).toBe(false)
  })

  it('falls back to the registry default when nothing overrides', () => {
    expect(resolveFlag({ name: FLAG, definition: { description: '', defaultEnabled: true }, override: null, envValue: undefined })).toBe(true)
    expect(resolveFlag({ name: FLAG, definition: { description: '', defaultEnabled: false }, override: null, envValue: undefined })).toBe(false)
  })

  it('applies rollout only while enabled, bucketing by subject', () => {
    const def = { description: '', defaultEnabled: true, rollout: 0 }
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 100 }, override: null, envValue: undefined, subject: 'u' })).toBe(true)
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 0 }, override: null, envValue: undefined, subject: 'u' })).toBe(false)
    // A disabled master switch beats any rollout.
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 100 }, override: { enabled: false }, envValue: undefined, subject: 'u' })).toBe(false)
    // Partial rollout with no subject is conservative (false — can't bucket).
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 50 }, override: null, envValue: undefined })).toBe(false)
  })

  it('a specific subject lands consistently inside a matching rollout', () => {
    // Find a subject whose bucket is < 25, then prove rollout 25 includes it and rollout 0 excludes it.
    const subject = Array.from({ length: 100 }, (_, i) => `u${i}`).find((s) => bucketFor(FLAG, s) < 25)!
    const def = { description: '', defaultEnabled: true }
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 25 }, override: null, envValue: undefined, subject })).toBe(true)
    expect(resolveFlag({ name: FLAG, definition: { ...def, rollout: 0 }, override: null, envValue: undefined, subject })).toBe(false)
  })
})

describe('isFeatureEnabled (store-backed)', () => {
  it('returns the registry default with no overrides', async () => {
    expect(await isFeatureEnabled(FLAG, 'u', freshDeps())).toBe(DEF.defaultEnabled) // true
  })

  it('honors an env kill switch over everything (and short-circuits the store)', async () => {
    vi.stubEnv('FLAG_EXPLANATIONS_LLM', 'off')
    const store = new InMemoryStore()
    await store.setJson(`flag:${FLAG}`, { enabled: true }) // would enable, but env wins
    expect(await isFeatureEnabled(FLAG, 'u', { store, logger: noop })).toBe(false)
  })

  it('honors a store override (flip off without a redeploy)', async () => {
    const deps = freshDeps()
    await deps.store.setJson(`flag:${FLAG}`, { enabled: false })
    expect(await isFeatureEnabled(FLAG, 'u', deps)).toBe(false)
  })

  it('honors a store rollout override deterministically', async () => {
    const deps = freshDeps()
    await deps.store.setJson(`flag:${FLAG}`, { enabled: true, rollout: 100 })
    expect(await isFeatureEnabled(FLAG, 'u', deps)).toBe(true)
    await deps.store.setJson(`flag:${FLAG}`, { enabled: true, rollout: 0 })
    expect(await isFeatureEnabled(FLAG, 'u', deps)).toBe(false)
  })

  it('is fail-open: a store error degrades to the registry default, not a throw', async () => {
    const store = {
      incrementWindow: async () => ({ count: 0, resetAt: 0 }),
      getJson: async () => {
        throw new Error('redis down')
      },
      setJson: async () => {},
      del: async () => {},
    }
    expect(await isFeatureEnabled(FLAG, 'u', { store, logger: noop })).toBe(DEF.defaultEnabled) // true
  })

  it('treats an unknown flag as disabled (and logs)', async () => {
    expect(await isFeatureEnabled('nope' as FlagName, 'u', { logger: noop })).toBe(false)
    expect(noop.warn).toHaveBeenCalled()
  })
})

describe('evaluateAllFlags', () => {
  it('resolves every registered flag for the subject (for observability stamping)', async () => {
    const all = await evaluateAllFlags('u', freshDeps())
    expect(all).toMatchObject({ explanations_llm: DEF.defaultEnabled }) // true by default
    expect(Object.keys(all)).toEqual(Object.keys(FLAG_REGISTRY))
  })

  it('reflects an env kill switch in the stamped set', async () => {
    vi.stubEnv('FLAG_EXPLANATIONS_LLM', 'off')
    const all = await evaluateAllFlags('u', freshDeps())
    expect(all.explanations_llm).toBe(false)
  })
})

describe('listFlags', () => {
  it('lists known flags with their env var name', () => {
    const flags = listFlags()
    const llm = flags.find((f) => f.name === FLAG)
    expect(llm).toMatchObject({ name: FLAG, envVar: 'FLAG_EXPLANATIONS_LLM', defaultEnabled: true })
    expect(typeof llm!.description).toBe('string')
  })
})
