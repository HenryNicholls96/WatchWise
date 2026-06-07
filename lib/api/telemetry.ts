// Fire-and-forget client telemetry. Uses sendBeacon when available (survives unload/navigation), falling
// back to fetch+keepalive. Never throws and never blocks the UI — telemetry must be invisible to the user.

export type ClientUxEvent = 'banner_shown' | 'banner_dismissed'

export function trackEvent(event: ClientUxEvent, opts: { eventId?: string; surface?: string } = {}): void {
  try {
    const body = JSON.stringify({ event, ...opts })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }))
      return
    }
    void fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Swallow — telemetry is best-effort.
  }
}
