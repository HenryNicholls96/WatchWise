// Chips that surface the constraints the engine applied to a search, so the filtering is transparent to
// the user (e.g. "Only movies", "On Netflix", "Excluding: Horror", "Under 2 hours"). Positives use a
// filled (secondary) badge; negatives use an outline badge so they read distinctly. Excluded-genre chips
// are individually REMOVABLE when onRelaxGenre is provided — clicking one adds that genre back to broaden
// the search.

import { Ban, Check, X } from 'lucide-react'
import type { AppliedConstraints } from '@/lib/api/recommendations'
import { Badge } from '@/components/ui/badge'

const PLATFORM_NAMES: Record<string, string> = {
  netflix: 'Netflix',
  prime: 'Prime Video',
  disney: 'Disney+',
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ru: 'Russian',
  ar: 'Arabic',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  tr: 'Turkish',
  pl: 'Polish',
}

function platformName(slug: string): string {
  return PLATFORM_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase()
}

function formatRuntime(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours > 1 ? 's' : ''}`
  }
  return `${minutes} min`
}

type Chip = { label: string; kind: 'include' | 'exclude'; genre?: string }

// Total platforms we carry — a "limited to all of them" set isn't a real narrowing, so we don't chip it.
const ALL_PLATFORMS = 3

function buildChips(c: AppliedConstraints): Chip[] {
  const chips: Chip[] = []

  if (c.contentType) {
    chips.push({ label: c.contentType === 'movie' ? 'Only movies' : 'Only series', kind: 'include' })
  }
  // Effective platform allow-set — only meaningful when it genuinely narrows the catalog.
  if (c.platforms.length > 0 && c.platforms.length < ALL_PLATFORMS) {
    chips.push({ label: `On ${c.platforms.map(platformName).join(', ')}`, kind: 'include' })
  }
  if (c.maxRuntimeMinutes != null) {
    chips.push({ label: `Under ${formatRuntime(c.maxRuntimeMinutes)}`, kind: 'include' })
  }
  if (c.originalLanguage) {
    chips.push({ label: `In ${languageName(c.originalLanguage)}`, kind: 'include' })
  }
  // One chip per excluded genre, each carrying its genre so it can be individually removed.
  for (const g of c.excludeGenres) {
    chips.push({ label: `Excluding: ${g}`, kind: 'exclude', genre: g })
  }

  return chips
}

export function ConstraintChips({
  constraints,
  onRelaxGenre,
}: {
  constraints?: AppliedConstraints
  /** When provided, excluded-genre chips become clickable — clicking one relaxes that exclusion. */
  onRelaxGenre?: (genre: string) => void
}) {
  if (!constraints) return null
  const chips = buildChips(constraints)
  if (chips.length === 0 && !constraints.genreExclusionsRelaxed) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Applied filters</span>
      {chips.map((chip) => {
        const key = `${chip.kind}:${chip.label}`
        const removable = chip.kind === 'exclude' && chip.genre != null && onRelaxGenre != null

        if (removable) {
          return (
            <button
              key={key}
              type="button"
              onClick={() => onRelaxGenre!(chip.genre!)}
              title={`Add ${chip.genre} back to broaden your results`}
              aria-label={`Remove filter excluding ${chip.genre} and broaden results`}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Badge
                variant="outline"
                className="cursor-pointer gap-1 font-normal transition-colors hover:bg-accent hover:text-foreground"
              >
                <Ban className="h-3 w-3" aria-hidden />
                {chip.label}
                <X className="h-3 w-3 opacity-60" aria-hidden />
              </Badge>
            </button>
          )
        }

        return (
          <Badge
            key={key}
            variant={chip.kind === 'include' ? 'secondary' : 'outline'}
            className="gap-1 font-normal"
          >
            {chip.kind === 'include' ? (
              <Check className="h-3 w-3" aria-hidden />
            ) : (
              <Ban className="h-3 w-3" aria-hidden />
            )}
            {chip.label}
          </Badge>
        )
      })}
      {constraints.genreExclusionsRelaxed && (
        <span className="text-xs text-muted-foreground">
          (relaxed genre filter to find matches)
        </span>
      )}
    </div>
  )
}
