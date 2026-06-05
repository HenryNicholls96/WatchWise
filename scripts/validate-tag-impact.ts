// scripts/validate-tag-impact.ts — DRY-RUN tag impact validator.
//
// Simulates the effect of candidate keyword→tag mappings against the live catalog
// WITHOUT writing anything. Run this BEFORE applying any new tag_mappings rows.
//
// Run:
//   npx tsx --env-file=.env.local scripts/validate-tag-impact.ts
//
// Edit CANDIDATE_MAPPINGS below to test a proposed batch. The script reports:
//   - How many titles gain ≥1 new tag
//   - Distribution of new tags per title
//   - Per-tag sample titles for manual signal review
//   - Over-tagging risk (titles gaining 4+ new tags)
//   - Per-keyword hit counts (which candidates actually fire, which are dead)
//   - Recall-loss check for any keyword listed in WATCH_KEYWORDS

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')
import { createClient } from '@supabase/supabase-js'

type TagType = 'mood' | 'theme'

// ── EDIT THIS to validate a proposed batch ───────────────────────────────────
const CANDIDATE_MAPPINGS: { keyword: string; type: TagType; tag: string }[] = [
  { keyword: 'superhero', type: 'theme', tag: 'superhero' },
  { keyword: 'superhero team', type: 'theme', tag: 'superhero' },
  { keyword: 'marvel cinematic universe (mcu)', type: 'theme', tag: 'superhero' },
  { keyword: 'supervillain', type: 'theme', tag: 'superhero' },
  { keyword: 'anime', type: 'theme', tag: 'anime' },
  { keyword: 'manga adaptation', type: 'theme', tag: 'anime' },
  { keyword: 'japanese animation', type: 'theme', tag: 'anime' },
  { keyword: 'musical', type: 'theme', tag: 'musical' },
  { keyword: 'musical film', type: 'theme', tag: 'musical' },
  { keyword: 'broadway adaptation', type: 'theme', tag: 'musical' },
  { keyword: 'musical theatre', type: 'theme', tag: 'musical' },
]

// Keywords to evaluate for false-positive / recall risk. The script reports which
// titles match ONLY via these keywords (i.e. would be lost if the keyword is dropped).
const WATCH_KEYWORDS: string[] = []

const SAMPLE_SIZE = 12
const OVER_TAG_THRESHOLD = 4

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as any
  const { data: rows, error } = await supabase
    .from('content')
    .select('title, type, mood_tags, theme_tags, tmdb_keywords')
  if (error) { console.error(error); process.exit(1) }

  const lookup = new Map<string, { type: TagType; tag: string }>()
  for (const m of CANDIDATE_MAPPINGS) lookup.set(`${m.keyword}|${m.type}`, { type: m.type, tag: m.tag })

  type Impact = { title: string; type: string; existing: string[]; newTags: string[]; matched: string[] }
  const impacts: Impact[] = []
  const dist: Record<number, number> = {}
  const perTag: Record<string, Impact[]> = {}
  const kwHits: Record<string, number> = {}

  for (const r of rows) {
    const kws: string[] = (r.tmdb_keywords ?? []).map((k: string) => k.toLowerCase().trim())
    const existingMood: string[] = r.mood_tags ?? []
    const existingTheme: string[] = r.theme_tags ?? []
    const newSet = new Set<string>()
    const matched: string[] = []
    for (const kw of kws) {
      for (const type of ['mood', 'theme'] as TagType[]) {
        const hit = lookup.get(`${kw}|${type}`)
        if (!hit) continue
        kwHits[kw] = (kwHits[kw] ?? 0) + 1
        const existing = type === 'mood' ? existingMood : existingTheme
        if (!existing.includes(hit.tag)) {
          newSet.add(`${type}:${hit.tag}`)
          matched.push(`${kw}→${type}:${hit.tag}`)
        }
      }
    }
    const newTags = [...newSet]
    if (newTags.length) {
      const imp: Impact = { title: r.title, type: r.type, existing: [...existingMood, ...existingTheme], newTags, matched }
      impacts.push(imp)
      dist[newTags.length] = (dist[newTags.length] ?? 0) + 1
      for (const t of newTags) (perTag[t] ??= []).push(imp)
    }
  }

  console.log(`\n═══ Q1: TITLES GAINING ≥1 NEW TAG ═══`)
  console.log(`${impacts.length} of ${rows.length} titles (${(impacts.length / rows.length * 100).toFixed(1)}%)`)

  console.log(`\n═══ Q2: NEW-TAGS-PER-TITLE DISTRIBUTION ═══`)
  for (const n of Object.keys(dist).map(Number).sort()) console.log(`  ${n} new: ${dist[n]} titles`)

  console.log(`\n═══ Q3: PER-TAG SAMPLES ═══`)
  for (const [tag, list] of Object.entries(perTag).sort()) {
    console.log(`\n--- ${tag} (${list.length}) ---`)
    for (const i of list.slice(0, SAMPLE_SIZE)) {
      console.log(`  • ${i.title} [${i.type}]  | matched: ${i.matched.join(', ')} | existing: ${i.existing.join(', ') || '(none)'}`)
    }
  }

  console.log(`\n═══ Q4: OVER-TAGGING (≥${OVER_TAG_THRESHOLD} new tags) ═══`)
  const over = impacts.filter(i => i.newTags.length >= OVER_TAG_THRESHOLD)
  console.log(over.length ? over.map(i => `  ⚠ ${i.title}: ${i.newTags.join(', ')}`).join('\n')
    : `  None. Max new tags on any title: ${Math.max(0, ...impacts.map(i => i.newTags.length))}`)

  console.log(`\n═══ KEYWORD HIT COUNTS ═══`)
  for (const m of CANDIDATE_MAPPINGS) {
    const n = kwHits[m.keyword] ?? 0
    console.log(`  ${String(n).padStart(3)}×  ${m.keyword} → ${m.type}:${m.tag}${n === 0 ? '   ⚠ DEAD (0 hits — forward-coverage only)' : ''}`)
  }

  if (WATCH_KEYWORDS.length) {
    console.log(`\n═══ RECALL-RISK CHECK ═══`)
    const candidateKws = new Set(CANDIDATE_MAPPINGS.map(m => m.keyword))
    for (const watch of WATCH_KEYWORDS) {
      const unambiguous = [...candidateKws].filter(k => k !== watch)
      const lostTitles: string[] = []
      for (const r of rows) {
        const kws: string[] = (r.tmdb_keywords ?? []).map((k: string) => k.toLowerCase().trim())
        if (kws.includes(watch) && !unambiguous.some(u => kws.includes(u))) lostTitles.push(r.title)
      }
      console.log(`  "${watch}": ${lostTitles.length} titles match ONLY via this keyword`)
      for (const t of lostTitles) console.log(`     • ${t}`)
    }
  }
}
main()
