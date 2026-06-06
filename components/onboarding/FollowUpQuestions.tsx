// Four quick segmented questions after the swipe deck. Every answer maps to a real engine knob
// (platforms → filter, content type → filter, avoid-genres → excludeGenres, runtime → cap), so they
// shape results immediately. Low-friction: nothing required — finish with any subset.

'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Preferences } from '@/lib/types/onboarding'

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
            'rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
            isSelected(o.value) ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-accent'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">{label}</p>
      {children}
    </div>
  )
}

const PLATFORM_OPTIONS: Option<string>[] = [
  { value: 'netflix', label: 'Netflix' },
  { value: 'prime', label: 'Prime Video' },
  { value: 'disney', label: 'Disney+' },
]
const CONTENT_OPTIONS: Option<NonNullable<Preferences['contentType']>>[] = [
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'Series' },
  { value: 'any', label: 'Both' },
]
// Values are canonical catalog genre strings; labels are friendlier.
const AVOID_OPTIONS: Option<string>[] = [
  { value: 'Horror', label: 'Horror' },
  { value: 'Romance', label: 'Romance' },
  { value: 'Reality', label: 'Reality TV' },
  { value: 'Documentary', label: 'Documentary' },
  { value: 'Animation', label: 'Animation' },
]
const RUNTIME_OPTIONS: Option<NonNullable<Preferences['runtime']>>[] = [
  { value: 'short', label: 'Quick (≤30m)' },
  { value: 'hour', label: '~1 hour' },
  { value: 'movie', label: 'Movie-length' },
  { value: 'any', label: 'Any' },
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
  const [contentType, setContentType] = useState<Preferences['contentType']>()
  const [avoidGenres, setAvoidGenres] = useState<string[]>([])
  const [runtime, setRuntime] = useState<Preferences['runtime']>()

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-2xl font-bold tracking-tight">Almost there</h2>
        <p className="text-sm text-muted-foreground">Four quick taps to sharpen your picks — skip anything</p>
      </div>

      <Field label="Where do you watch?">
        <Segmented
          options={PLATFORM_OPTIONS}
          isSelected={(v) => platforms.includes(v)}
          onSelect={(v) => setPlatforms((prev) => toggle(prev, v))}
        />
      </Field>
      <Field label="Movies, series, or both?">
        <Segmented options={CONTENT_OPTIONS} isSelected={(v) => contentType === v} onSelect={setContentType} />
      </Field>
      <Field label="Anything you'd rather skip?">
        <Segmented
          options={AVOID_OPTIONS}
          isSelected={(v) => avoidGenres.includes(v)}
          onSelect={(v) => setAvoidGenres((prev) => toggle(prev, v))}
        />
      </Field>
      <Field label="How long, usually?">
        <Segmented options={RUNTIME_OPTIONS} isSelected={(v) => runtime === v} onSelect={setRuntime} />
      </Field>

      <Button
        size="lg"
        className="h-12"
        disabled={submitting}
        onClick={() => onSubmit({ platforms, preferences: { contentType, avoidGenres, runtime } })}
      >
        {submitting ? 'Lining up your picks…' : 'Let’s Get Started!'}
      </Button>
    </div>
  )
}
