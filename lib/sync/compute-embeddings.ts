// Embedding computation — turns content.embedding_input into a 512-dim Voyage vector.
//
// Implements hash-based drift detection: a title is (re-)embedded only when its
// embedding has never been computed, or its embedding_input has changed since the
// last embed (md5(embedding_input) != embedded_input_hash). This makes the step
// idempotent and cheap to run repeatedly — only drifted titles are touched.
//
// Pure & dependency-injected so it can run from a CLI (scripts/embed.ts) or an
// Inngest function. No env access, no process.exit here — callers own those.

import { createHash } from 'node:crypto'
import { VoyageAIClient } from 'voyageai'
import pLimit from 'p-limit'
import type { SupabaseClient } from '@supabase/supabase-js'

const EMBED_MODEL = 'voyage-3-lite'
const EMBED_DIMENSIONS = 512
const EMBED_BATCH_SIZE = 100        // Voyage hard limit is 128 inputs/request; 100 is safe headroom
const WRITE_CONCURRENCY = 10        // parallel row updates after each batch embeds
const MAX_RETRIES = 3
const INTER_BATCH_DELAY_MS = 200

/** md5 of a UTF-8 string — matches Postgres md5() exactly. Single source of truth for drift. */
export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

export type EmbedLogger = {
  log: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: EmbedLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(`  ⚠  ${m}`),
  error: (m) => console.error(`  ✗ ${m}`),
}

export type EmbedSummary = {
  candidates: number          // titles found needing embedding
  embedded: number            // successfully embedded + written
  skippedNoInput: number      // had no embedding_input to embed
  failed: number              // errored during embed or write
  durationMs: number
  failedTitles: { id: string; title: string; reason: string }[]
}

export type ComputeEmbeddingsDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>
  voyageApiKey: string
  logger?: EmbedLogger
  batchSize?: number
}

type Candidate = { id: string; title: string; embedding_input: string }

/**
 * Computes and persists embeddings for all titles whose embedding has drifted or is missing.
 *
 * Drift rule (computed in JS so there is exactly one md5 implementation in play):
 *   needs embedding  ⇔  embedding IS NULL
 *                       OR md5(embedding_input) != embedded_input_hash
 *
 * On success per title, writes: embedding, embedded_input_hash, embedding_synced_at.
 * Per-title failures are isolated — they are logged and counted, never fatal.
 */
export async function computeEmbeddings(deps: ComputeEmbeddingsDeps): Promise<EmbedSummary> {
  const { supabase, voyageApiKey } = deps
  const logger = deps.logger ?? consoleLogger
  const batchSize = deps.batchSize ?? EMBED_BATCH_SIZE
  const started = Date.now()

  const voyage = new VoyageAIClient({ apiKey: voyageApiKey })

  // ── Identify candidates (vector column never fetched — only the small text columns) ──
  const candidates = await findDriftedTitles(supabase, logger)

  const summary: EmbedSummary = {
    candidates: candidates.withInput.length + candidates.skippedNoInput,
    embedded: 0,
    skippedNoInput: candidates.skippedNoInput,
    failed: 0,
    durationMs: 0,
    failedTitles: [],
  }

  if (candidates.withInput.length === 0) {
    logger.log(`  ✓ Nothing to embed — all titles up to date${candidates.skippedNoInput ? ` (${candidates.skippedNoInput} skipped: no embedding_input)` : ''}`)
    summary.durationMs = Date.now() - started
    return summary
  }

  logger.log(`  Found ${candidates.withInput.length} title(s) needing embedding` +
    (candidates.skippedNoInput ? `, ${candidates.skippedNoInput} skipped (no embedding_input)` : ''))

  const writeLimit = pLimit(WRITE_CONCURRENCY)

  for (let i = 0; i < candidates.withInput.length; i += batchSize) {
    const batch = candidates.withInput.slice(i, i + batchSize)
    const inputs = batch.map(c => c.embedding_input)

    let vectors: number[][]
    try {
      vectors = await embedBatchWithRetry(voyage, inputs, logger)
    } catch (err) {
      // Whole batch failed after retries — mark each title failed, continue with next batch
      for (const c of batch) {
        summary.failed++
        summary.failedTitles.push({ id: c.id, title: c.title, reason: `embed failed: ${errMsg(err)}` })
      }
      logger.warn(`Batch ${Math.floor(i / batchSize) + 1} embed failed: ${errMsg(err)} (${batch.length} titles)`)
      continue
    }

    // Persist each row; isolate per-row write failures
    await Promise.all(batch.map((c, idx) => writeLimit(async () => {
      const vector = vectors[idx]
      if (!vector || vector.length !== EMBED_DIMENSIONS) {
        summary.failed++
        summary.failedTitles.push({ id: c.id, title: c.title, reason: `bad vector length: ${vector?.length ?? 'null'}` })
        return
      }
      const { error } = await supabase
        .from('content')
        .update({
          embedding: `[${vector.join(',')}]`,                 // pgvector text format
          embedded_input_hash: md5(c.embedding_input),
          embedding_synced_at: new Date().toISOString(),
        })
        .eq('id', c.id)

      if (error) {
        summary.failed++
        summary.failedTitles.push({ id: c.id, title: c.title, reason: `write failed: ${error.message}` })
      } else {
        summary.embedded++
      }
    })))

    logger.log(`  Progress: ${Math.min(i + batchSize, candidates.withInput.length)}/${candidates.withInput.length} embedded`)
    if (i + batchSize < candidates.withInput.length) {
      await sleep(INTER_BATCH_DELAY_MS)
    }
  }

  summary.durationMs = Date.now() - started
  return summary
}

// ─── Candidate discovery ──────────────────────────────────────────────────────

type DriftResult = { withInput: Candidate[]; skippedNoInput: number }

async function findDriftedTitles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  logger: EmbedLogger
): Promise<DriftResult> {
  // (1) Rows never embedded — embedding column is NULL.
  const { data: neverEmbedded, error: e1 } = await supabase
    .from('content')
    .select('id, title, embedding_input')
    .is('embedding', null)
  if (e1) throw new Error(`Failed to query un-embedded titles: ${e1.message}`)

  // (2) Rows already embedded — fetch only the small text columns (never the vector)
  //     and keep those whose input has drifted from what was embedded.
  const { data: embedded, error: e2 } = await supabase
    .from('content')
    .select('id, title, embedding_input, embedded_input_hash')
    .not('embedding', 'is', null)
  if (e2) {
    if (/embedded_input_hash/.test(e2.message)) {
      throw new Error(
        'Column content.embedded_input_hash is missing. Apply migration ' +
        '003_tag_governance.sql in the Supabase SQL Editor before running the embed step.'
      )
    }
    throw new Error(`Failed to query embedded titles: ${e2.message}`)
  }

  const withInput: Candidate[] = []
  let skippedNoInput = 0

  for (const row of neverEmbedded ?? []) {
    if (!row.embedding_input?.trim()) { skippedNoInput++; continue }
    withInput.push({ id: row.id, title: row.title, embedding_input: row.embedding_input })
  }

  for (const row of embedded ?? []) {
    if (!row.embedding_input?.trim()) { skippedNoInput++; continue }
    if (md5(row.embedding_input) !== row.embedded_input_hash) {
      withInput.push({ id: row.id, title: row.title, embedding_input: row.embedding_input })
    }
  }

  if (skippedNoInput > 0) {
    logger.warn(`${skippedNoInput} title(s) have no embedding_input — run the seed pipeline first`)
  }

  return { withInput, skippedNoInput }
}

// ─── Voyage embed with retry/backoff ──────────────────────────────────────────

async function embedBatchWithRetry(
  voyage: VoyageAIClient,
  inputs: string[],
  logger: EmbedLogger
): Promise<number[][]> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await voyage.embed({
        input: inputs,
        model: EMBED_MODEL,
        inputType: 'document',          // content documents (queries use 'query' at search time)
        outputDimension: EMBED_DIMENSIONS,
      })

      const data = res.data ?? []
      if (data.length !== inputs.length) {
        throw new Error(`Voyage returned ${data.length} embeddings for ${inputs.length} inputs`)
      }

      // Align strictly by index — never trust array order
      const out: number[][] = new Array(inputs.length)
      for (const item of data) {
        if (item.index == null || !item.embedding) throw new Error('Voyage response item missing index/embedding')
        out[item.index] = item.embedding
      }
      if (out.some(v => v == null)) throw new Error('Voyage response had gaps in index coverage')
      return out
    } catch (err) {
      lastErr = err
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * 2 ** attempt
        logger.warn(`Voyage embed attempt ${attempt + 1} failed (${errMsg(err)}) — retrying in ${delay}ms`)
        await sleep(delay)
      }
    }
  }
  throw lastErr
}

// ─── small helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
