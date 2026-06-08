// movieofthenight catalogue source adapter — the CatalogSource implementation for the Streaming
// Availability API. Two capabilities: enumerate a service catalogue (paginated) and re-fetch one show
// (used by the accuracy audit's internal-consistency check). A future JustWatch source would implement
// the same shape, leaving the pipeline untouched.
//
// Auth: x-api-key header. Validation: each item is parsed with motnShowSchema; malformed items are
// skipped (logged by the caller), never propagated.

import axios from 'axios'
import { type Logger, noopLogger } from '@/lib/types/logger'
import { type CatalogPage, type MotnShow, catalogPageSchema, motnShowSchema } from '@/lib/sync/catalog/types'

const TIMEOUT_MS = 20_000
const MAX_RETRIES = 3

const http = axios.create({ timeout: TIMEOUT_MS, validateStatus: () => true })

export type CatalogSource = {
  /** Enumerate one page of a service catalogue in a region. */
  listPage(opts: { country: string; catalog: string; cursor?: string | null }): Promise<CatalogPage>
  /** Re-fetch a single show by its motn id (for the audit). Null on 404. */
  getShow(id: string, country: string): Promise<MotnShow | null>
}

export function createCatalogSource(
  apiKey: string,
  baseUrl: string,
  deps: { logger?: Logger } = {}
): CatalogSource {
  const logger = deps.logger ?? noopLogger
  const headers = { 'x-api-key': apiKey }

  async function get<T>(url: string): Promise<{ status: number; data: T }> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await http.get<T>(url, { headers })
        if (res.status === 429 || res.status === 503) throw new Error(`HTTP ${res.status}`)
        return { status: res.status, data: res.data }
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    throw lastErr
  }

  /** Parse the raw shows array, dropping (and counting) anything that fails the boundary schema. */
  function parseShows(raw: unknown[]): MotnShow[] {
    const out: MotnShow[] = []
    let dropped = 0
    for (const item of raw) {
      const parsed = motnShowSchema.safeParse(item)
      if (parsed.success) out.push(parsed.data)
      else dropped++
    }
    if (dropped > 0) logger.warn('catalog: dropped malformed shows', { dropped })
    return out
  }

  return {
    async listPage({ country, catalog, cursor }) {
      const params = new URLSearchParams({ country, catalogs: catalog, orderBy: 'popularity_1year' })
      if (cursor) params.set('cursor', cursor)
      const { status, data } = await get<unknown>(`${baseUrl}/v4/shows/search/filters?${params.toString()}`)
      if (status !== 200) throw new Error(`catalog list failed (HTTP ${status})`)
      const page = catalogPageSchema.parse(data)
      return {
        shows: parseShows(page.shows),
        hasMore: page.hasMore ?? false,
        nextCursor: page.nextCursor ?? null,
      }
    },

    async getShow(id, country) {
      const { status, data } = await get<unknown>(`${baseUrl}/v4/shows/${encodeURIComponent(id)}?country=${country}`)
      if (status === 404) return null
      if (status !== 200) throw new Error(`catalog getShow failed (HTTP ${status})`)
      const parsed = motnShowSchema.safeParse(data)
      return parsed.success ? parsed.data : null
    },
  }
}
