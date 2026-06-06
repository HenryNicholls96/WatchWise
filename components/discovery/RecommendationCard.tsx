// A single recommendation card: poster, title with platform icons top-right, a one-line gist of
// what it's about, and a ratings footer (WatchWise star rating + a blended Rating). Clicking
// (or Enter/Space) opens a detail dialog. The WatchWise rating and Critics score use the exact same
// components in the card and the modal, so their wording/format always match. The Dialog is
// controlled (no DialogTrigger asChild) so we don't depend on Card forwarding refs to a Radix Slot.

'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Film, Sparkles, Star } from 'lucide-react'
import type { Recommendation } from '@/lib/api/recommendations'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PlatformIconRow } from '@/components/discovery/PlatformIcon'
import { WatchWiseMark } from '@/components/brand/WatchWiseLogo'

function metaLine(content: Recommendation['content']): string {
  const parts: string[] = [content.type === 'movie' ? 'Movie' : 'Series']
  if (content.releaseYear) parts.push(String(content.releaseYear))
  if (content.type === 'series' && content.seasonCount) {
    parts.push(`${content.seasonCount} season${content.seasonCount > 1 ? 's' : ''}`)
  }
  if (content.type === 'movie' && content.runtimeMinutes) parts.push(`${content.runtimeMinutes} min`)
  return parts.join(' · ')
}

/** A complete, single-thought gist of the title (its first sentence), so nothing reads as cut off. */
function shortSummary(content: Recommendation['content']): string {
  const desc = content.description?.trim()
  if (desc) {
    const match = desc.match(/^.*?[.!?](\s|$)/)
    return (match ? match[0] : desc).trim()
  }
  if (content.genres.length > 0) return `${content.genres.slice(0, 3).join(', ')}.`
  return 'No summary available yet.'
}

// WatchWise's recommendation strength is shown as a RANK-BASED star rating, not the raw composite
// percentage (which is cosine-bound and reads misleadingly low). The top pick gets 5★ and the rating
// eases down by rank to a 3★ floor, so the best match always feels strong and the gradient is clear.
const STAR_TOP = 5
const STAR_FLOOR = 3
function rankStars(index: number, total: number): number {
  if (total <= 1) return STAR_TOP
  const raw = STAR_TOP - (index / (total - 1)) * (STAR_TOP - STAR_FLOOR)
  return Math.round(raw * 2) / 2 // nearest half-star
}

/**
 * The blended 0–100 "Rating" (IMDb + Metacritic + TMDb). Falls back to the TMDb score until the
 * enrichment job has populated blended_rating; null only when there's no rating at all.
 */
function ratingScore(content: Recommendation['content']): number | null {
  if (content.blendedRating != null) return Math.round(content.blendedRating)
  if (content.tmdbRating != null) return Math.round(content.tmdbRating * 10)
  return null
}

const SOURCE_NAMES: Record<string, string> = { imdb: 'IMDb', metacritic: 'Metacritic', tmdb: 'TMDb' }

/** Tooltip text listing which sources the blended rating came from. */
function ratingSourcesLabel(content: Recommendation['content']): string {
  const contributing = content.ratingSources?.contributing
  const keys = contributing && contributing.length > 0 ? contributing : ['tmdb']
  return `Rating · blended from ${keys.map((s) => SOURCE_NAMES[s] ?? s).join(', ')}`
}

function tagSet(content: Recommendation['content']): Set<string> {
  return new Set(
    [...content.genres, ...content.moodTags, ...content.themeTags].map((t) => t.trim().toLowerCase())
  )
}

/** Picks up to 4 sibling recommendations most similar by shared genres/tags (fallback: same type). */
function pickSimilar(current: Recommendation, siblings: Recommendation[]): Recommendation[] {
  const curTags = tagSet(current.content)
  const scored = siblings
    .filter((s) => s.content.id !== current.content.id)
    .map((s) => {
      let overlap = 0
      for (const t of tagSet(s.content)) if (curTags.has(t)) overlap++
      return { s, overlap }
    })
    .sort((a, b) => b.overlap - a.overlap)

  const related = scored.filter((x) => x.overlap > 0).map((x) => x.s)
  const fallback = scored.map((x) => x.s).filter((s) => s.content.type === current.content.type)
  return (related.length > 0 ? related : fallback).slice(0, 4)
}

function Poster({ url, title, className }: { url: string | null; title: string; className: string }) {
  if (!url) {
    return (
      <div className={`flex items-center justify-center rounded-lg bg-muted ${className}`}>
        <Film className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
    )
  }
  return (
    <Image
      src={url}
      alt={`${title} poster`}
      width={154}
      height={231}
      loading="lazy"
      className={`rounded-lg object-cover ${className}`}
      unoptimized
    />
  )
}

/** Five stars with fractional fill, driven by a 0–5 value. */
function StarRating({ value, sizeClass = 'h-3.5 w-3.5' }: { value: number; sizeClass?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, value - i))
        return (
          <span key={i} className={cn('relative inline-block', sizeClass)}>
            <Star className={cn('absolute inset-0', sizeClass, 'text-muted-foreground/30')} />
            {fill > 0 && (
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star className={cn(sizeClass, 'fill-amber-400 text-amber-400')} />
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}

/** Shared WatchWise rating lockup: "W" mark + star rating. Used identically in card and modal. */
function WatchWiseRating({
  stars,
  markClassName = 'h-4 w-4 text-[10px]',
  starClass,
}: {
  stars: number
  markClassName?: string
  starClass?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5" title="WatchWise Recommendation Rating">
      <WatchWiseMark className={markClassName} />
      <StarRating value={stars} sizeClass={starClass} />
    </span>
  )
}

/** Shared blended "Rating" lockup. Used identically in card and modal. */
function RatingScore({ value, sourcesLabel }: { value: number; sourcesLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 leading-none" title={sourcesLabel}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rating</span>
      <span className="font-bold">{value}%</span>
    </span>
  )
}

export function RecommendationCard({
  recommendation,
  siblings,
  explanation,
  explanationLoading = false,
}: {
  recommendation: Recommendation
  siblings: Recommendation[]
  /** Deferred "why this" text, fetched separately and only shown in the modal. */
  explanation?: string
  /** True while the explanation prefetch is still in flight for this card. */
  explanationLoading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const { content, confidence, platforms } = recommendation
  const whyText = explanation && explanation.trim() ? explanation : null
  const similar = pickSimilar(recommendation, siblings)
  const rank = Math.max(0, siblings.findIndex((s) => s.content.id === content.id))
  const stars = rankStars(rank, siblings.length)
  const rating = ratingScore(content)
  const ratingSources = ratingSourcesLabel(content)

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        aria-label={`View details for ${content.title}`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className="group flex h-full cursor-pointer flex-row gap-4 p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative w-[7rem] shrink-0 self-stretch">
          <Poster url={content.posterUrl} title={content.title} className="h-full w-full" />
          {confidence === 'high' && (
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-semibold shadow-sm backdrop-blur">
              <Sparkles className="h-2.5 w-2.5" /> Top match
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
          <h3 className="font-semibold leading-snug tracking-tight">{content.title}</h3>
          <p className="text-xs font-medium text-muted-foreground">{metaLine(content)}</p>
          <p className="mt-0.5 line-clamp-3 text-sm text-foreground/80">{shortSummary(content)}</p>

          <div className="mt-auto flex flex-col gap-2 pt-3">
            <WatchWiseRating stars={stars} />
            <div className="flex items-center justify-between gap-2">
              {rating != null && <RatingScore value={rating} sourcesLabel={ratingSources} />}
              <PlatformIconRow platforms={platforms} size="xs" />
            </div>
          </div>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] gap-5 overflow-y-auto sm:max-w-lg">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-xl">{content.title}</DialogTitle>
            <DialogDescription>{metaLine(content)}</DialogDescription>
          </DialogHeader>

          {/* The right column is sized to the poster's height so "Where to watch" sits at its top and the
              ratings sit at its bottom — both visually anchored to the poster. */}
          <div className="flex gap-4">
            <Poster url={content.posterUrl} title={content.title} className="h-48 w-32 shrink-0" />
            <div className="flex h-48 min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                {content.genres.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {content.genres.map((g) => (
                      <Badge key={g} variant="secondary">
                        {g}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span />
                )}
                {platforms.length > 0 && (
                  <div className="flex shrink-0 flex-col items-end gap-1 rounded-lg border bg-muted/30 px-2 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Where to watch
                    </span>
                    <PlatformIconRow platforms={platforms} size="xs" />
                  </div>
                )}
              </div>

              <div className="mt-auto flex flex-col items-start gap-1.5">
                <WatchWiseRating stars={stars} markClassName="h-5 w-5 text-xs" starClass="h-4 w-4" />
                {rating != null && <RatingScore value={rating} sourcesLabel={ratingSources} />}
              </div>
            </div>
          </div>

          <section className="space-y-1.5">
            <h4 className="font-semibold">Why This One?</h4>
            {whyText ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{whyText}</p>
            ) : explanationLoading ? (
              <p className="text-sm italic leading-relaxed text-muted-foreground/70">Thinking about why this fits…</p>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">A strong match for what you asked for.</p>
            )}
          </section>

          {content.description && (
            <section className="space-y-1.5">
              <h4 className="font-semibold">Summary</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">{content.description}</p>
            </section>
          )}

          {similar.length > 0 && (
            <section className="space-y-2">
              <h4 className="font-semibold">Similar to</h4>
              <div className="grid grid-cols-4 gap-3">
                {similar.map((s) => (
                  <div key={s.content.id} className="flex flex-col gap-1">
                    <Poster
                      url={s.content.posterUrl}
                      title={s.content.title}
                      className="aspect-[2/3] w-full"
                    />
                    <p className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
                      {s.content.title}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
