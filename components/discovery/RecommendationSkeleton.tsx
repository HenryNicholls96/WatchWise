// Skeleton placeholder mirroring RecommendationCard's layout for the loading state.

import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function RecommendationSkeleton() {
  return (
    <Card className="flex flex-row gap-4 p-4">
      <Skeleton className="h-40 w-[6.5rem] shrink-0 self-center rounded-lg" />
      <div className="flex flex-1 flex-col gap-2 py-1">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="mt-1 h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <div className="mt-auto flex gap-1.5 pt-2">
          <Skeleton className="h-7 w-7 rounded-lg" />
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
      </div>
    </Card>
  )
}

export function RecommendationSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <RecommendationSkeleton key={i} />
      ))}
    </div>
  )
}
