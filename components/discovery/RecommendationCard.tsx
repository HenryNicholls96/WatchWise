// A single recommendation card: poster, title with platform icons top-right, a one-line gist of
// what it's about, and a ratings footer (WatchWise "Match" score + a blended "Critics" score). Clicking
// (or Enter/Space) opens a detail dialog. The Match and Critics scores use the exact same components in
// the card and the modal, so their wording/format always match. The Dialog is controlled (no
// DialogTrigger asChild) so we don't depend on Card forwarding refs to a Radix Slot.

'use client'

import { useState, type MouseEvent } from 'react'
import Image from 'next/image'
import { AnimatePresence, motion } from 'framer-motion'
import { Eye, Film, Sparkles, Star, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { Recommendation } from '@/lib/api/recommendations'
import { recordInteraction } from '@/lib/api/interactions'
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

/** Tooltip text listing which sources the blended Critics score came from. */
function ratingSourcesLabel(content: Recommendation['content']): string {
  const contributing = content.ratingSources?.contributing
  const keys = contributing && contributing.length > 0 ? contributing : ['tmdb']
  return `Critics · blended from ${keys.map((s) => SOURCE_NAMES[s] ?? s).join(', ')}`
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

/**
 * Shared WatchWise "Match" lockup: "W" mark + "Match" label + a numeric star rating (e.g. "4.5 ★"), so
 * it's obvious the number reflects fit-for-you, not an external review score. Used identically in card
 * and modal. The value is the rank-based 0–5 strength from rankStars (shown to one decimal).
 */
function WatchWiseRating({
  stars,
  markClassName = 'h-4 w-4 text-[10px]',
  starClass = 'h-3.5 w-3.5',
}: {
  stars: number
  markClassName?: string
  starClass?: string
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title="WatchWise Match — how well this fits your taste and search"
    >
      <WatchWiseMark className={markClassName} />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Match</span>
      <span
        className="inline-flex items-center gap-0.5 font-bold leading-none tabular-nums"
        role="img"
        aria-label={`Match ${stars.toFixed(1)} out of 5`}
      >
        {stars.toFixed(1)}
        <Star className={cn(starClass, 'fill-amber-400 text-amber-400')} aria-hidden />
      </span>
    </span>
  )
}

/** Shared blended "Critics" lockup (IMDb/Metacritic/TMDb). Used identically in card and modal. */
function RatingScore({ value, sourcesLabel }: { value: number; sourcesLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 leading-none" title={sourcesLabel}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Critics</span>
      <span className="font-bold">{value}%</span>
    </span>
  )
}

export function RecommendationCard({
  recommendation,
  siblings,
  explanation,
  explanationLoading = false,
  onOpen,
  fallbackExplanation,
}: {
  recommendation: Recommendation
  siblings: Recommendation[]
  /** Deferred "why this" text, fetched separately and only shown in the modal. */
  explanation?: string
  /** True while the explanation prefetch is still in flight for this card. */
  explanationLoading?: boolean
  /** Fired once when the detail modal is opened — used for engagement telemetry (e.g. the For-You rail). */
  onOpen?: () => void
  /** Copy shown in the modal when there's no LLM explanation (e.g. For-You cards, which skip the prefetch). */
  fallbackExplanation?: string
}) {
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [sentimentDone, setSentimentDone] = useState(false)
  const { content, confidence, platforms, alreadySeen } = recommendation
  const whyText = explanation && explanation.trim() ? explanation : null
  const fallbackWhy = fallbackExplanation ?? 'A strong match for what you asked for.'

  function openDetail() {
    setOpen(true)
    onOpen?.()
  }
  // Optimistic dismiss: hide the card immediately, record the signal fire-and-forget. recordInteraction
  // never throws, so a network failure just means the signal is lost — the card stays dismissed (no jarring
  // re-appear). stopPropagation keeps the ✕ from opening the detail modal.
  function dismiss(e: MouseEvent) {
    e.stopPropagation()
    setDismissed(true)
    void recordInteraction(content.id, 'dismissed')
  }
  function sendSentiment(action: 'loved' | 'not_for_me') {
    setSentimentDone(true)
    void recordInteraction(content.id, action)
  }
  const similar = pickSimilar(recommendation, siblings)
  const rank = Math.max(0, siblings.findIndex((s) => s.content.id === content.id))
  const stars = rankStars(rank, siblings.length)
  const rating = ratingScore(content)
  const ratingSources = ratingSourcesLabel(content)

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          key={content.id}
          initial={false}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2, ease: 'easeOut' } }}
          className="h-full"
        >
          <Card
            role="button"
            tabIndex={0}
            aria-label={`View details for ${content.title}`}
            onClick={openDetail}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openDetail()
              }
            }}
            className="group relative flex h-full cursor-pointer flex-row gap-4 p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Dismiss: subtle but present on touch, hover/focus-revealed on desktop. Never opens the modal. */}
            <button
              type="button"
              onClick={dismiss}
              aria-label={`Dismiss ${content.title}`}
              className="absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-70 shadow-sm backdrop-blur transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>

            <div className="relative w-[7rem] shrink-0 self-stretch">
              <Poster url={content.posterUrl} title={content.title} className="h-full w-full" />
              {confidence === 'high' && (
                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-semibold shadow-sm backdrop-blur">
                  <Sparkles className="h-2.5 w-2.5" /> Top match
                </span>
              )}
              {/* Calm, low-contrast "already watched" cue — helpful, never judgmental. */}
              {alreadySeen && (
                <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur">
                  <Eye className="h-2.5 w-2.5" aria-hidden /> Seen
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

          {/* The right column is sized to the poster's height: platform icons sit at its top-right (anchored
              to the poster's top edge) and the ratings sit at its bottom. */}
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
                  <div className="shrink-0">
                    <PlatformIconRow platforms={platforms} size="sm" />
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
              <p className="text-sm leading-relaxed text-muted-foreground">{fallbackWhy}</p>
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

          {/* Progressive disclosure: quick sentiment lives in the OPENED modal, not on the grid — keeps the
              default view minimal. Optional, calm, one-tap; records to the append-only interaction log. */}
          <div className="flex items-center gap-2 border-t pt-3">
            {sentimentDone ? (
              <p className="text-xs text-muted-foreground">Thanks — noted for next time.</p>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">Good pick?</span>
                <button
                  type="button"
                  onClick={() => sendSentiment('loved')}
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ThumbsUp className="h-3 w-3" aria-hidden /> Loved it
                </button>
                <button
                  type="button"
                  onClick={() => sendSentiment('not_for_me')}
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ThumbsDown className="h-3 w-3" aria-hidden /> Not for me
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
