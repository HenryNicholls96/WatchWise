// One calm screen of progressive follow-up questions after the swipe deck. Every answer maps to a real
// engine signal: platforms → filter, media type → content-type / required-genre filter, favourite genres →
// positive category-affinity, avoid → soft excludeGenres. Documentary sub-genres are captured as soft hints
// (reserved for documentary-aware ranking). Low-friction: nothing required — finish with any subset.

'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { MediaType, Preferences } from '@/lib/types/onboarding'

type Option<T extends string> = { value: T; label: string }

function Segmented<T extends string>({
  options,
  isSelected,
  onSelect,
}: {
  options: Option<T>[]
  isSelected: (value: T) => boolean
  onSelect: (value: T) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={isSelected(o.value)}
          onClick={() => onSelect(o.value)}
          className={cn(
            'min-h-11 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
            isSelected(o.value) ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-accent'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

const PLATFORM_OPTIONS: Option<string>[] = [
  { value: 'netflix', label: 'Netflix' },
  { value: 'prime', label: 'Prime Video' },
  { value: 'disney', label: 'Disney+' },
]
const MEDIA_OPTIONS: Option<MediaType>[] = [
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'Series' },
  { value: 'documentary', label: 'Documentaries' },
  { value: 'all', label: 'All' },
]
// Values are canonical catalog genre strings (each maps to a swipe category via the registry); labels are
// friendlier. Picking these boosts the matching category's affinity.
const FAVOURITE_OPTIONS: Option<string>[] = [
  { value: 'Crime', label: 'Crime' },
  { value: 'Thriller', label: 'Thriller' },
  { value: 'Mystery', label: 'Mystery' },
  { value: 'Science Fiction', label: 'Sci-Fi' },
  { value: 'Fantasy', label: 'Fantasy' },
  { value: 'Comedy', label: 'Comedy' },
  { value: 'Romance', label: 'Romance' },
  { value: 'Family', label: 'Family' },
  { value: 'Drama', label: 'Drama' },
  { value: 'History', label: 'History' },
  { value: 'Action', label: 'Action' },
  { value: 'Adventure', label: 'Adventure' },
]
// Stored as soft hints (no hard filter in v1).
const DOC_SUBGENRE_OPTIONS: Option<string>[] = [
  { value: 'True Crime', label: 'True Crime' },
  { value: 'Nature & Wildlife', label: 'Nature & Wildlife' },
  { value: 'Science & Tech', label: 'Science & Tech' },
  { value: 'History', label: 'History' },
  { value: 'Sports', label: 'Sports' },
  { value: 'Music', label: 'Music' },
  { value: 'Society & Politics', label: 'Society & Politics' },
  { value: 'Biography', label: 'Biography' },
]
// "Documentary" intentionally omitted — it would contradict the Documentaries media type.
const AVOID_OPTIONS: Option<string>[] = [
  { value: 'Horror', label: 'Horror' },
  { value: 'Romance', label: 'Romance' },
  { value: 'Reality', label: 'Reality TV' },
  { value: 'Animation', label: 'Animation' },
]

export type FollowUpAnswers = { platforms: string[]; preferences: Preferences }

export function FollowUpQuestions({
  onSubmit,
  submitting,
}: {
  onSubmit: (answers: FollowUpAnswers) => void
  submitting: boolean
}) {
  const [platforms, setPlatforms] = useState<string[]>([])
  const [mediaType, setMediaType] = useState<MediaType>()
  const [favouriteGenres, setFavouriteGenres] = useState<string[]>([])
  const [documentarySubgenres, setDocumentarySubgenres] = useState<string[]>([])
  const [avoidGenres, setAvoidGenres] = useState<string[]>([])

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  // Documentary sub-genres are only relevant when the user wants documentaries (directly or via "All").
  const showDocs = mediaType === 'documentary' || mediaType === 'all'

  function handleSubmit() {
    onSubmit({
      platforms,
      preferences: {
        mediaType,
        favouriteGenres,
        // Only send sub-genres that the (visible) section could have produced.
        documentarySubgenres: showDocs ? documentarySubgenres : [],
        avoidGenres,
      },
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-2xl font-bold tracking-tight">Almost there</h2>
        <p className="text-sm text-muted-foreground">A few quick taps to sharpen your picks — skip anything</p>
      </div>

      <Field label="Where do you watch?">
        <Segmented
          options={PLATFORM_OPTIONS}
          isSelected={(v) => platforms.includes(v)}
          onSelect={(v) => setPlatforms((prev) => toggle(prev, v))}
        />
      </Field>

      <Field label="What are you in the mood for?">
        <Segmented options={MEDIA_OPTIONS} isSelected={(v) => mediaType === v} onSelect={setMediaType} />
      </Field>

      <Field label="Most favourite kinds?" hint="Pick a few you love — we'll lean into these.">
        <Segmented
          options={FAVOURITE_OPTIONS}
          isSelected={(v) => favouriteGenres.includes(v)}
          onSelect={(v) => setFavouriteGenres((prev) => toggle(prev, v))}
        />
      </Field>

      <AnimatePresence initial={false}>
        {showDocs && (
          <motion.div
            key="doc-subgenres"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <Field label="Which documentaries?" hint="Optional — helps us tune the docs we show you.">
              <Segmented
                options={DOC_SUBGENRE_OPTIONS}
                isSelected={(v) => documentarySubgenres.includes(v)}
                onSelect={(v) => setDocumentarySubgenres((prev) => toggle(prev, v))}
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>

      <Field label="Anything you'd rather skip?">
        <Segmented
          options={AVOID_OPTIONS}
          isSelected={(v) => avoidGenres.includes(v)}
          onSelect={(v) => setAvoidGenres((prev) => toggle(prev, v))}
        />
      </Field>

      <Button size="lg" className="h-12" disabled={submitting} onClick={handleSubmit}>
        {submitting ? 'Lining up your picks…' : 'Let’s Get Started!'}
      </Button>
    </div>
  )
}
