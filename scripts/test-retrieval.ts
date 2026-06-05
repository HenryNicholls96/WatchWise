// scripts/test-retrieval.ts — manual validation harness for the retrieval layer.
//
// Runs a natural-language query against the live catalog and prints the top matches
// with similarity scores, so we can eyeball retrieval quality.
//
// Usage:
//   npm run test:retrieval -- "something like The Bear but lighter and funny"
//   npm run test:retrieval -- "tense sci-fi thriller" 15
//   (second arg = how many results to show; default 10)

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import { createClient } from '@supabase/supabase-js'
import { VoyageAIClient } from 'voyageai'
import { retrieveCandidates, createVoyageEmbeddingClient, RetrievalError } from '../lib/recommendations/retrieval'
import { consoleLogger } from '../lib/types/logger'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`\n❌ Missing env var ${name}. Run via: npm run test:retrieval -- "your query"\n`)
    process.exit(1)
  }
  return v
}

async function main() {
  const query = process.argv[2]
  const topN = Number(process.argv[3] ?? 10)

  if (!query) {
    console.error('\nUsage: npm run test:retrieval -- "your natural language query" [topN]\n')
    process.exit(1)
  }

  const supabase = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const voyage = new VoyageAIClient({ apiKey: requireEnv('VOYAGE_API_KEY') })
  const embeddingClient = createVoyageEmbeddingClient(voyage, consoleLogger)

  console.log(`\n━━━ Retrieval test ━━━`)
  console.log(`Query: "${query}"\n`)

  try {
    const candidates = await retrieveCandidates({ queryText: query, limit: 100 }, {
      supabase,
      embeddingClient,
      logger: consoleLogger,
    })

    console.log(`\nTop ${Math.min(topN, candidates.length)} of ${candidates.length} candidates:\n`)
    candidates.slice(0, topN).forEach((c, i) => {
      const { content, vectorSimilarity } = c
      const tags = [...content.moodTags.slice(0, 3), ...content.themeTags.slice(0, 3)].join(', ')
      const year = content.releaseYear ?? '—'
      console.log(
        `  ${String(i + 1).padStart(2)}. [${vectorSimilarity.toFixed(4)}] ${content.title} (${year}) · ${content.type}`
      )
      console.log(`        genres: ${content.genres.join(', ') || '—'}`)
      console.log(`        tags:   ${tags || '—'}`)
    })
    console.log('')
  } catch (err) {
    if (err instanceof RetrievalError) {
      console.error(`\n✗ RetrievalError [${err.code}]: ${err.message}\n`)
    } else {
      console.error(`\n✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    process.exit(1)
  }
}

main()
