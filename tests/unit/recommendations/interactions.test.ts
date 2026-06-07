import { describe, expect, it, vi } from 'vitest'
import { loadSeenContentIds } from '@/lib/recommendations/interactions'

// Minimal thenable query chain: select().eq().in().in() then awaited → { data, error }.
function fakeSupabase(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  }
  return { from: vi.fn(() => chain) }
}

describe('loadSeenContentIds', () => {
  it('returns the set of seen content ids among the candidates', async () => {
    const sb = fakeSupabase({ data: [{ content_id: 'a' }, { content_id: 'b' }], error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const set = await loadSeenContentIds('u1', ['a', 'b', 'c'], sb as any)
    expect([...set].sort()).toEqual(['a', 'b'])
  })

  it('is empty (fail-open) on a DB error', async () => {
    const sb = fakeSupabase({ data: null, error: { message: 'boom' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await loadSeenContentIds('u1', ['a'], sb as any)).size).toBe(0)
  })

  it('does not query when there are no candidate ids', async () => {
    const sb = fakeSupabase({ data: [], error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const set = await loadSeenContentIds('u1', [], sb as any)
    expect(set.size).toBe(0)
    expect(sb.from).not.toHaveBeenCalled()
  })
})
