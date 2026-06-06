// App-wide client providers. Hosts the TanStack Query client (project convention for all async data).

'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function Providers({ children }: { children: React.ReactNode }) {
  // Created once per client via useState so the cache survives re-renders but isn't shared across requests.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 2 * 60 * 1000, refetchOnWindowFocus: false },
        },
      })
  )

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
