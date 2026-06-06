// WatchWise compact brand mark — a "W" chip on a black background, in the app's font (inherited).
// Used next to the WatchWise rating on cards and in the detail modal.

import { cn } from '@/lib/utils'

export function WatchWiseMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-[5px] bg-black font-bold leading-none text-white',
        className
      )}
      aria-hidden
    >
      W
    </span>
  )
}
