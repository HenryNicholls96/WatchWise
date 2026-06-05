// Retrieval — step 1 of the recommendation pipeline.
//
// Embeds the user's raw query with Voyage (voyage-3-lite, 512-dim, inputType 'query'),
// then runs an index-accelerated pgvector cosine search via the match_content RPC and
// returns the top-N candidates with their similarity scores.
//
// Design notes vs recommendation-engine.md:
//   • The doc's signature was retrieveCandidates(input, supabase) with the Voyage call
//     hidden inside. We inject an EmbeddingClient interface instead so the layer is unit
//     testable without a live Voyage account, satisfying the DI mandate. Pure improvement.
//   • Query and document embeddings are asymmetric by design: documents were embedded with
//     inputType 'document' at ingestion; queries use 'query'. voyage-3-lite is trained for
//     this asymmetry — do not "fix" it to match.

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { type Candidate, parseContentRow } from '@/lib/types/content'
import { type Logger, noopLogger } from '@/lib/types/logger'

// ─── Constants ────────────────────────────────────────────────────────────────

/** voyage-3-lite output dimensionality — must match the content.embedding column. */
export const QUERY_EMBED_DIMENSIONS = 512
const QUERY_EMBED_MODEL = 'voyage-3-lite'

/** Default and hard-cap candidate counts. Retrieval is cheap; downstream steps trim further. */
export const DEFAULT_CANDIDATE_LIMIT = 100
const MAX_CANDIDATE_LIMIT = 200

const MAX_QUERY_LENGTH = 1_000 // guards against accidental megabyte payloads being embedded

// ─── Errors ───────────────────────────────────────────────────────────────────

export type RetrievalErrorCode = 'INVALID_INPUT' | 'EMBEDDING_FAILED' | 'SEARCH_FAILED'

/** Typed error so callers can distinguish input/embedding/search failures and react accordingly. */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode
  override readonly cause?: unknown
  constructor(code: RetrievalErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'RetrievalError'
    this.code = code
    this.cause = cause
  }
}

// ─── Injectable embedding client ──────────────────────────────────────────────

/** Narrow interface the retrieval layer depends on. Mock it in tests; back it with Voyage in prod. */
export interface EmbeddingClient {
  /** Returns a 512-dim query embedding for the given text. */
  embedQuery(text: string): Promise<number[]>
}

// Minimal structural type for the Voyage SDK method we use — avoids coupling to its full shape.
type VoyageLike = {
  embed(req: {
    input: string
    model: string
    inputType: 'query' | 'document'
    outputDimension?: number
  }): Promise<{ data?: { embedding?: number[] }[] }>
}

const EMBED_MAX_RETRIES = 3

/**
 * Voyage-backed EmbeddingClient with bounded retry/backoff on transient failures.
 * Validates the returned vector length so a malformed response can't corrupt search.
 */
export function createVoyageEmbeddingClient(voyage: VoyageLike, logger: Logger = noopLogger): EmbeddingClient {
  return {
    async embedQuery(text: string): Promise<number[]> {
      let lastErr: unknown
      for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
        try {
          const res = await voyage.embed({
            input: text,
            model: QUERY_EMBED_MODEL,
            inputType: 'query',
            outputDimension: QUERY_EMBED_DIMENSIONS,
          })
          const embedding = res.data?.[0]?.embedding
          if (!embedding || embedding.length !== QUERY_EMBED_DIMENSIONS) {
            throw new Error(`expected ${QUERY_EMBED_DIMENSIONS}-dim embedding, got ${embedding?.length ?? 'none'}`)
          }
          return embedding
        } catch (err) {
          lastErr = err
          if (attempt < EMBED_MAX_RETRIES) {
            const delay = 1_000 * 2 ** attempt
            logger.warn('query embed attempt failed — retrying', { attempt: attempt + 1, delayMs: delay })
            await sleep(delay)
          }
        }
      }
      throw new RetrievalError('EMBEDDING_FAILED', 'failed to embed query after retries', lastErr)
    },
  }
}

// ─── Public contract ──────────────────────────────────────────────────────────

export type RetrievalInput = {
  /** Raw user query — embedded as-is in v1 (no intent parsing). */
  queryText: string
  /** Max candidates to return. Defaults to DEFAULT_CANDIDATE_LIMIT; capped at MAX_CANDIDATE_LIMIT. */
  limit?: number
}

export type RetrievalDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>
  embeddingClient: EmbeddingClient
  logger?: Logger
}

// Shape of one match_content RPC row (snake_case) before validation/mapping.
const rpcRowSchema = z.object({ similarity: z.coerce.number() }).passthrough()

/**
 * Retrieves the top-N catalog titles most semantically similar to the query.
 *
 * Pipeline: validate input → embed query (Voyage) → cosine search (pgvector RPC) →
 * validate + map rows → Candidate[] sorted by descending similarity.
 *
 * @throws RetrievalError with code INVALID_INPUT | EMBEDDING_FAILED | SEARCH_FAILED.
 */
export async function retrieveCandidates(
  input: RetrievalInput,
  deps: RetrievalDeps
): Promise<Candidate[]> {
  const logger = deps.logger ?? noopLogger

  const queryText = input.queryText?.trim()
  if (!queryText) {
    throw new RetrievalError('INVALID_INPUT', 'queryText must be a non-empty string')
  }
  if (queryText.length > MAX_QUERY_LENGTH) {
    throw new RetrievalError('INVALID_INPUT', `queryText exceeds ${MAX_QUERY_LENGTH} characters`)
  }
  const limit = clampLimit(input.limit)

  // 1) Embed the query.
  const embedding = await deps.embeddingClient.embedQuery(queryText)

  // 2) Vector search via RPC. pgvector accepts the bracketed text format for the vector arg.
  const { data, error } = await deps.supabase.rpc('match_content', {
    query_embedding: `[${embedding.join(',')}]`,
    match_count: limit,
  })

  if (error) {
    logger.error('match_content RPC failed', { message: error.message })
    throw new RetrievalError('SEARCH_FAILED', `vector search failed: ${error.message}`, error)
  }

  // 3) Validate + map rows. A schema mismatch is a hard error, not a silent skip.
  const rows = Array.isArray(data) ? data : []
  let candidates: Candidate[]
  try {
    candidates = rows.map((raw) => {
      const parsed = rpcRowSchema.parse(raw)
      return {
        content: parseContentRow(parsed),
        vectorSimilarity: parsed.similarity,
      }
    })
  } catch (err) {
    throw new RetrievalError('SEARCH_FAILED', 'match_content returned an unexpected row shape', err)
  }

  // RPC already orders by distance, but we re-sort defensively in case of RPC changes.
  candidates.sort((a, b) => b.vectorSimilarity - a.vectorSimilarity)

  logger.info('retrieval complete', {
    query: queryText,
    returned: candidates.length,
    topSimilarity: candidates[0]?.vectorSimilarity ?? null,
  })

  return candidates
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_CANDIDATE_LIMIT
  return Math.max(1, Math.min(MAX_CANDIDATE_LIMIT, Math.floor(limit)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
