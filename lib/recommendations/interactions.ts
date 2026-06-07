// Interaction read helpers — the single "seen source" the engine uses to stamp `alreadySeen` and (later)
// the global Seen/Not-Seen filter uses to exclude. Reading from one place keeps the badge, the dismiss
// action, and the filter perfectly consistent.

import type { SupabaseClient } from '@supabase/supabase-js'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { SEEN_ACTIONS } from '@/lib/types/interactions'

/**
 * Of the given content ids, which has the user marked as SEEN (any of SEEN_ACTIONS) in the append-only
 * interaction log? One indexed query scoped to the candidate ids (never a full-table scan). FAIL-OPEN:
 * any error → empty set, so a stamping hiccup never blocks recommendations.
 */
export async function loadSeenContentIds(
  userId: string,
  contentIds: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  logger: Logger = noopLogger
): Promise<Set<string>> {
  if (contentIds.length === 0) return new Set()
  try {
    const { data, error } = await supabase
      .from('user_content_interactions')
      .select('content_id')
      .eq('user_id', userId)
      .in('content_id', contentIds)
      .in('action', SEEN_ACTIONS as unknown as string[])
    if (error) {
      logger.warn('seen-set load failed (treating as none seen)', { message: error.message })
      return new Set()
    }
    return new Set((data ?? []).map((r: { content_id: string }) => r.content_id))
  } catch (err) {
    logger.warn('seen-set load threw (treating as none seen)', {
      message: err instanceof Error ? err.message : String(err),
    })
    return new Set()
  }
}
