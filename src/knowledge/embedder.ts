import { createHash } from 'node:crypto';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Embedding and reranking, behind interfaces.
 *
 * Nothing outside this file imports a provider. Everything else — the
 * knowledge service, the routes, the seed script — depends only on `Embedder`
 * and `Reranker`, so swapping providers again is a change to one file and one
 * env var.
 *
 * Current provider: OpenAI text-embedding-3-small, asked for 1024 dimensions
 * via the `dimensions` parameter so the existing `vector(1024)` column and its
 * HNSW index are unchanged.
 *
 * OpenAI has no reranking model, so the second stage is lexical and runs
 * in process. That is a deliberate trade: a network round trip to a reranker
 * would sit inside the Vonage AI Studio five second webhook ceiling, and a
 * BM25-ish pass over twenty candidates is both free and enough to fix the
 * failure mode embeddings actually have — confusing "high chair" with "high
 * stool" because they are near each other in vector space.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export interface Embedder {
  /** Documents as stored. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Queries as searched with. Kept separate: some providers embed them differently. */
  embedQuery(text: string): Promise<number[]>;
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface Reranker {
  rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Batched so one oversized document cannot fail a whole re-index, and to
    // stay inside the request size limit.
    for (let i = 0; i < texts.length; i += 96) {
      out.push(...(await this.call(texts.slice(i, i + 96))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.call([text]);
    if (!embedding) throw new Error('OpenAI returned no embedding for the query');
    return embedding;
  }

  private async call(input: string[]): Promise<number[][]> {
    const response = await fetch(`${OPENAI_BASE}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        model: this.model,
        // Keeps the stored vectors at the column's width. Without this the
        // model returns 1536 and every insert fails on dimension mismatch.
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * Lexical reranking over the vector stage's candidates.
 *
 * Scores on how much of the query's vocabulary a chunk actually contains,
 * normalised by length so a long menu does not outrank a two line answer just
 * by being long. Runs in microseconds and makes no network call.
 */
export class LexicalReranker implements Reranker {
  async rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]> {
    const queryTerms = new Set(tokenise(query));
    if (queryTerms.size === 0) {
      return documents.slice(0, topK).map((_, index) => ({ index, score: 0 }));
    }

    return documents
      .map((doc, index) => {
        const terms = tokenise(doc);
        if (terms.length === 0) return { index, score: 0 };
        const unique = new Set(terms);
        const covered = [...queryTerms].filter((t) => unique.has(t)).length;
        const density = terms.filter((t) => queryTerms.has(t)).length / Math.sqrt(terms.length);
        // Coverage dominates: a chunk mentioning every word of the question
        // once beats one that repeats a single word ten times.
        return { index, score: covered / queryTerms.size + density * 0.1 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// Test and offline implementations
// ---------------------------------------------------------------------------

/**
 * Deterministic, offline, no network.
 *
 * Hashes token unigrams and bigrams into the embedding space. Not semantic,
 * but stable across runs and it does place documents sharing vocabulary near
 * one another, which is what the retrieval plumbing needs in order to be
 * tested end to end without pretending to be a real model.
 */
export class NoopEmbedder implements Embedder {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbed);
  }

  async embedQuery(text: string): Promise<number[]> {
    return hashEmbed(text);
  }
}

/** Preserves the candidate order the vector stage produced. */
export class NoopReranker implements Reranker {
  async rerank(_query: string, documents: string[], topK: number): Promise<RerankResult[]> {
    return documents.slice(0, topK).map((_, index) => ({ index, score: 1 - index / documents.length }));
  }
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function hashEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenise(text);
  for (let i = 0; i < tokens.length; i++) {
    for (const gram of [tokens[i]!, tokens.slice(i, i + 2).join(' ')]) {
      const digest = createHash('sha256').update(gram).digest();
      const slot = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
      const sign = (digest[4]! & 1) === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }
  }
  // Cosine distance needs unit vectors to behave.
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

// ---------------------------------------------------------------------------

export function buildEmbedder(): Embedder {
  const config = env();
  if (!config.OPENAI_API_KEY) {
    logger().warn(
      { kind: 'embedder_stub' },
      'OPENAI_API_KEY not set, using the deterministic offline embedder',
    );
    return new NoopEmbedder();
  }
  return new OpenAIEmbedder(config.OPENAI_API_KEY, config.OPENAI_EMBED_MODEL);
}

export function buildReranker(): Reranker {
  // Lexical either way: it needs no key and makes no network call, so there is
  // no configuration under which the stub is preferable.
  return new LexicalReranker();
}
