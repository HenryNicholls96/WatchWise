// Read-only chips that surface the constraints the engine applied to a search, so the filtering is
// transparent to the user (e.g. "Only movies", "On Netflix", "Excluding: Horror", "Under 2 hours").
// Positives use a filled (secondary) badge; negatives use an outline badge so they read distinctly.

import { Ban, Check } from 'lucide-react'
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

type Chip = { label: string; kind: 'include' | 'exclude' }

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
  if (c.excludeGenres.length > 0) {
    chips.push({ label: `Excluding: ${c.excludeGenres.join(', ')}`, kind: 'exclude' })
  }

  return chips
}

export function ConstraintChips({ constraints }: { constraints?: AppliedConstraints }) {
  if (!constraints) return null
  const chips = buildChips(constraints)
  if (chips.length === 0 && !constraints.genreExclusionsRelaxed) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Applied filters</span>
      {chips.map((chip) => (
        <Badge
          key={`${chip.kind}:${chip.label}`}
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
      ))}
      {constraints.genreExclusionsRelaxed && (
        <span className="text-xs text-muted-foreground">
          (relaxed genre filter to find matches)
        </span>
      )}
    </div>
  )
}
