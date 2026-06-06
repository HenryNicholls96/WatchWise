// Supabase-backed ExplanationCache — persists Claude explanations across requests so repeat
// (title, query, taste) combinations skip the LLM. Backed by the service-role-only `explanation_cache`
// table (migration 008).
//
// FAIL-OPEN: every operation is best-effort. A read error/miss returns undefined (→ regenerate), and a
// write error is swallowed. So if the table doesn't exist yet, or Supabase is unavailable, behaviour
// degrades to "no cache" rather than breaking recommendations.
//
// INVALIDATION: TTL enforced on read (rows older than ttlMs are treated as a miss and overwritten on
// the next set). The cache key (content_id:query_hash:taste_sig) already changes when the query or the
// user's taste set changes, so those invalidate naturally.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Logger, noopLogger } from '@/lib/types/logger'
import type { ExplanationCache } from '@/lib/recommendations/explanations'

const TABLE = 'explanation_cache'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h, per CLAUDE.md

export function createSupabaseExplanationCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  opts: { ttlMs?: number; logger?: Logger } = {}
): ExplanationCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const logger = opts.logger ?? noopLogger

  return {
    async get(key: string): Promise<string | undefined> {
      try {
        const { data, error } = await supabase
          .from(TABLE)
          .select('explanation, created_at')
          .eq('cache_key', key)
          .maybeSingle()

        if (error) {
          logger.debug('explanation cache get failed (fail-open → miss)', { message: error.message })
          return undefined
        }
        if (!data) return undefined
        if (!isWithinTtl(data.created_at, ttlMs)) return undefined // stale/malformed → miss

        return data.explanation as string
      } catch (err) {
        logger.debug('explanation cache get threw (fail-open → miss)', {
          message: err instanceof Error ? err.message : String(err),
        })
        return undefined
      }
    },

    async set(key: string, value: string): Promise<void> {
      try {
        const { error } = await supabase
          .from(TABLE)
          .upsert({ cache_key: key, explanation: value, created_at: new Date().toISOString() }, { onConflict: 'cache_key' })
        if (error) logger.debug('explanation cache set failed (fail-open)', { message: error.message })
      } catch (err) {
        logger.debug('explanation cache set threw (fail-open)', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    // Batched read for a whole result set — ONE round-trip instead of one per title. Only fresh rows
    // are returned; stale/malformed ones are omitted (treated as misses, same as get).
    async getMany(keys: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (keys.length === 0) return out
      try {
        const { data, error } = await supabase
          .from(TABLE)
          .select('cache_key, explanation, created_at')
          .in('cache_key', keys)

        if (error) {
          logger.debug('explanation cache getMany failed (fail-open → miss)', { message: error.message })
          return out
        }
        for (const row of (data ?? []) as Array<{ cache_key: string; explanation: string; created_at: string }>) {
          if (isWithinTtl(row.created_at, ttlMs)) out.set(row.cache_key, row.explanation)
        }
        return out
      } catch (err) {
        logger.debug('explanation cache getMany threw (fail-open → miss)', {
          message: err instanceof Error ? err.message : String(err),
        })
        return out
      }
    },

    // Batched write — ONE upsert for every freshly generated explanation in the request.
    async setMany(entries: Array<{ key: string; value: string }>): Promise<void> {
      if (entries.length === 0) return
      try {
        const createdAt = new Date().toISOString()
        const rows = entries.map((e) => ({ cache_key: e.key, explanation: e.value, created_at: createdAt }))
        const { error } = await supabase.from(TABLE).upsert(rows, { onConflict: 'cache_key' })
        if (error) logger.debug('explanation cache setMany failed (fail-open)', { message: error.message })
      } catch (err) {
        logger.debug('explanation cache setMany threw (fail-open)', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}

/**
 * True only when `createdAt` parses to a finite epoch within `ttlMs`. A malformed/unparseable timestamp
 * yields NaN → false, so a bad row is treated as a miss and never served as fresh.
 */
function isWithinTtl(createdAt: unknown, ttlMs: number): boolean {
  const t = new Date(createdAt as string).getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= ttlMs
}
