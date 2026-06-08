// Catalog platform registry — the ONE place that maps a WatchWise platform slug to its movieofthenight
// service id + region. Adding a future platform (ITVX, Channel 4, …) is a config entry here plus a
// `platforms` row; the ingestion pipeline and the motn source adapter are reused unchanged.
//
// `slug` MUST match both our `platforms.slug` and the motn service id (confirmed live: iplayer / itvx /
// all4). `region` is the ISO country code used for both the motn `country` param and content_platforms.region.

export type CatalogPlatform = {
  /** WatchWise platform slug (= platforms.slug = motn service id). */
  slug: string
  /** Human-readable name (for logs). */
  name: string
  /** motn `catalogs` value to enumerate. Usually identical to slug. */
  motnCatalog: string
  /** ISO country/region code (motn `country` + content_platforms.region). */
  region: string
}

export const CATALOG_PLATFORMS: Record<string, CatalogPlatform> = {
  iplayer: { slug: 'iplayer', name: 'BBC iPlayer', motnCatalog: 'iplayer', region: 'gb' },
  // Future (same motn adapter, config-only): 'itvx', 'all4' …
}

export function getCatalogPlatform(slug: string): CatalogPlatform | undefined {
  return CATALOG_PLATFORMS[slug]
}
