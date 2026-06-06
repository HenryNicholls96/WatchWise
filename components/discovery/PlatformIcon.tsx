// Compact, recognizable platform marks. lucide-react carries no brand logos and we don't want a
// trademark-SVG dependency for the slice, so each platform is a clean brand-colored chip with its
// monogram. Renders as a deep link when one is available; always labeled for screen readers.

import type { Recommendation } from '@/lib/api/recommendations'

type PlatformOffer = Recommendation['platforms'][number]

type Brand = { mark: string; bg: string; fg: string }

const BRANDS: Record<string, Brand> = {
  netflix: { mark: 'N', bg: '#E50914', fg: '#FFFFFF' },
  prime: { mark: 'P', bg: '#00A8E1', fg: '#FFFFFF' },
  disney: { mark: 'D+', bg: '#0C204A', fg: '#FFFFFF' },
}

function brandFor(slug: string, name: string): Brand {
  return BRANDS[slug] ?? { mark: (name[0] ?? '?').toUpperCase(), bg: '#3F3F46', fg: '#FFFFFF' }
}

const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-xs',
} as const

export function PlatformIcon({
  platform,
  size = 'sm',
}: {
  platform: PlatformOffer
  size?: keyof typeof SIZES
}) {
  const brand = brandFor(platform.slug, platform.name)
  const label = platform.deepLink ? `Watch on ${platform.name}` : `Available on ${platform.name}`

  const chip = (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg font-bold leading-none shadow-sm ${SIZES[size]}`}
      style={{ backgroundColor: brand.bg, color: brand.fg }}
      aria-hidden
    >
      {brand.mark}
    </span>
  )

  if (!platform.deepLink) {
    return (
      <span title={platform.name} aria-label={label} role="img">
        {chip}
      </span>
    )
  }

  return (
    <a
      href={platform.deepLink}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className="rounded-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {chip}
    </a>
  )
}

export function PlatformIconRow({
  platforms,
  size = 'sm',
}: {
  platforms: PlatformOffer[]
  size?: keyof typeof SIZES
}) {
  if (platforms.length === 0) {
    return <span className="text-xs text-muted-foreground">Availability unavailable</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {platforms.map((p) => (
        <PlatformIcon key={p.slug} platform={p} size={size} />
      ))}
    </div>
  )
}
