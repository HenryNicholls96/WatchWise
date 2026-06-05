// scripts/embed.ts — CLI runner for the embedding pipeline (Step 5).
//
// Computes Voyage embeddings for all titles whose embedding_input has drifted
// or was never embedded. Idempotent and safe to run repeatedly.
//
// Run:
//   npm run embed
//   (equivalently: npx tsx --env-file=.env.local scripts/embed.ts)
//
// Run this AFTER any seed run or tag-mapping change so that new/updated
// embedding_input strings are reflected in the vectors used by search.

// Force IPv4 DNS — fixes ECONNRESET on Windows where Node.js prefers IPv6.
import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import { createClient } from '@supabase/supabase-js'
import { computeEmbeddings } from '../lib/sync/compute-embeddings'

function validateEnv(): void {
  const required = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VOYAGE_API_KEY']
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error('\n❌ Missing required environment variables:')
    missing.forEach(k => console.error(`   ${k}`))
    console.error('\n   Run with: npm run embed\n')
    process.exit(1)
  }
}

async function main() {
  console.log('\n━━━ WatchWise Embedding Pipeline ━━━\n')
  validateEnv()

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const summary = await computeEmbeddings({
    supabase,
    voyageApiKey: process.env.VOYAGE_API_KEY!,
  })

  console.log('\n─── Summary ───')
  console.log(`  Candidates found : ${summary.candidates}`)
  console.log(`  Embedded         : ${summary.embedded}`)
  console.log(`  Skipped (no input): ${summary.skippedNoInput}`)
  console.log(`  Failed           : ${summary.failed}`)
  console.log(`  Duration         : ${(summary.durationMs / 1000).toFixed(1)}s`)

  if (summary.failedTitles.length > 0) {
    console.log('\n  Failed titles:')
    for (const f of summary.failedTitles) console.log(`    • ${f.title} — ${f.reason}`)
  }

  console.log('')
  // Non-zero exit if anything failed, so CI / automation can detect partial runs.
  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\n✗ Embedding pipeline crashed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
