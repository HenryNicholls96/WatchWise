// Client wrapper for POST /api/interactions. Fire-and-forget by design: the UI updates optimistically,
// so a failed signal must never surface an error to the user — at worst the action just isn't recorded.

import type { ClientInteractionAction } from '@/lib/types/interactions'

/**
 * Records a discovery interaction (dismiss / quick sentiment / marked-seen). Resolves to whether it was
 * persisted; never throws. Callers should treat it as best-effort and not await it on the hot path.
 */
export async function recordInteraction(
  contentId: string,
  action: ClientInteractionAction,
  journeyId?: string
): Promise<boolean> {
  try {
    const res = await fetch('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(journeyId ? { contentId, action, journeyId } : { contentId, action }),
      keepalive: true, // survive a navigation/unmount mid-flight
    })
    return res.ok
  } catch {
    return false
  }
}
