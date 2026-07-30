import { createHash } from 'node:crypto';
import type { KnowledgeSource, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { logger } from '../lib/logger.js';
import { chunkDocument } from './chunker.js';
import { generateDocuments } from './generated.js';
import { EMBEDDING_DIMENSIONS, type Embedder, type Reranker } from './embedder.js';

/**
 * Retrieval over restaurant knowledge.
 *
 * The read path is: embed the query (cached), pull the top 20 by cosine
 * distance scoped to this restaurant, rerank to the top 4. Two stages because
 * embeddings alone confuse "do you have a high chair" with "do you have high
 * stools", and the reranker sees the actual words.
 *
 * pgvector columns cannot be expressed in Prisma, so every read and write of
 * `embedding` goes through raw SQL here. Each of those queries is scoped by
 * restaurant_id in the SQL itself — raw SQL is exactly where a tenant leak
 * would go unnoticed, so it is written explicitly every time.
 */

export interface KnowledgeDeps {
  db: PrismaClient;
  cache: Redis;
  embedder: Embedder;
  reranker: Reranker;
}

export interface SearchHit {
  id: string;
  title: string;
  source: KnowledgeSource;
  content: string;
  score: number;
}

/** How many candidates the vector stage hands to the reranker. */
const CANDIDATE_COUNT = 20;
const DEFAULT_TOP_K = 4;
const QUERY_CACHE_TTL_SECONDS = 86_400; // one day, per spec

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeDeps) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async search(restaurantId: string, query: string, topK = DEFAULT_TOP_K): Promise<SearchHit[]> {
    const embedding = await this.embedQueryCached(query);

    const candidates = await this.deps.db.$queryRawUnsafe<
      Array<{ id: string; title: string; source: KnowledgeSource; content: string; distance: number }>
    >(
      `SELECT id, title, source, content, embedding <=> $1::vector AS distance
         FROM knowledge_chunks
        WHERE restaurant_id = $2::uuid
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      toVectorLiteral(embedding),
      restaurantId,
      CANDIDATE_COUNT,
    );

    if (candidates.length === 0) return [];

    try {
      const ranked = await this.deps.reranker.rerank(
        query,
        candidates.map((c) => c.content),
        topK,
      );
      return ranked
        .map((r) => {
          const candidate = candidates[r.index];
          if (!candidate) return null;
          return {
            id: candidate.id,
            title: candidate.title,
            source: candidate.source,
            content: candidate.content,
            score: r.score,
          };
        })
        .filter((h): h is SearchHit => h !== null);
    } catch (error) {
      // A reranker outage degrades to vector order rather than to no answer.
      logger().warn({ err: error, kind: 'rerank_failed' }, 'Rerank failed, falling back to vector order');
      return candidates.slice(0, topK).map((c) => ({
        id: c.id,
        title: c.title,
        source: c.source,
        content: c.content,
        score: 1 - c.distance,
      }));
    }
  }

  /**
   * Query embeddings cached in Redis for a day, keyed by a hash of the text.
   *
   * Callers ask the same handful of questions — the menu, parking, dogs — so
   * this removes a network round trip from the majority of knowledge lookups,
   * which is the difference between comfortably inside the latency budget and
   * not.
   */
  private async embedQueryCached(query: string): Promise<number[]> {
    const normalised = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `embed:q:${createHash('sha256').update(normalised).digest('hex')}`;

    try {
      const cached = await this.deps.cache.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as number[];
        if (Array.isArray(parsed) && parsed.length === EMBEDDING_DIMENSIONS) return parsed;
      }
    } catch {
      // Cache miss by any other name.
    }

    const embedding = await this.deps.embedder.embedQuery(normalised);
    this.deps.cache
      .set(key, JSON.stringify(embedding), 'EX', QUERY_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return embedding;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** Chunk, embed and store one document, replacing any chunks it had before. */
  async indexDocument(documentId: string): Promise<number> {
    const { db } = this.deps;
    const document = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } });

    await db.knowledgeDocument.update({
      where: { id: documentId },
      data: { embedStatus: 'processing', embedError: null },
    });

    try {
      const chunks = chunkDocument(document.content, { documentTitle: document.title });
      const embeddings = await this.deps.embedder.embedDocuments(chunks.map((c) => c.content));

      await db.$transaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { documentId } });
        for (const [i, chunk] of chunks.entries()) {
          const embedding = embeddings[i];
          if (!embedding) continue;
          // Raw SQL because of the vector column. Scoped by restaurant_id on
          // the document it came from, never from a request parameter.
          await tx.$executeRawUnsafe(
            `INSERT INTO knowledge_chunks
               (id, restaurant_id, document_id, source, title, content, embedding, token_count, chunk_index, created_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::knowledge_source, $4, $5, $6::vector, $7, $8, now())`,
            document.restaurantId,
            documentId,
            document.source,
            chunk.title,
            chunk.content,
            toVectorLiteral(embedding),
            chunk.tokenCount,
            chunk.index,
          );
        }
      });

      await db.knowledgeDocument.update({
        where: { id: documentId },
        data: { embedStatus: 'ready', embedError: null },
      });
      return chunks.length;
    } catch (error) {
      await db.knowledgeDocument.update({
        where: { id: documentId },
        data: { embedStatus: 'failed', embedError: String((error as Error).message ?? error).slice(0, 500) },
      });
      throw error;
    }
  }

  /**
   * Rewrite the documents derived from structured data.
   *
   * Called after any change to hours, floors or tables. Upserts by
   * generationKey so it is safe to run on every write and never accumulates
   * duplicates.
   */
  async regenerateDerived(restaurantId: string): Promise<string[]> {
    const { db } = this.deps;
    const generated = await generateDocuments(db, restaurantId);
    const ids: string[] = [];

    for (const doc of generated) {
      const record = await db.knowledgeDocument.upsert({
        where: {
          knowledge_generation_key: { restaurantId, generationKey: doc.generationKey },
        },
        create: {
          restaurantId,
          source: doc.source,
          title: doc.title,
          content: doc.content,
          isGenerated: true,
          generationKey: doc.generationKey,
          embedStatus: 'pending',
        },
        update: { title: doc.title, content: doc.content, embedStatus: 'pending', embedError: null },
      });
      ids.push(record.id);
    }
    return ids;
  }

  /**
   * Re-embed every document that needs it.
   *
   * Runs detached from the request that triggered it: an admin saving a menu
   * should get a 202 immediately, not wait on an embedding API. Failures are
   * recorded on the document row rather than thrown into a response nobody is
   * listening to any more.
   */
  async processPending(restaurantId: string): Promise<{ indexed: number; failed: number }> {
    const pending = await this.deps.db.knowledgeDocument.findMany({
      where: { restaurantId, embedStatus: { in: ['pending', 'failed'] } },
      select: { id: true },
    });

    let indexed = 0;
    let failed = 0;
    for (const doc of pending) {
      try {
        await this.indexDocument(doc.id);
        indexed++;
      } catch (error) {
        failed++;
        logger().error({ err: error, kind: 'embed_failed', document_id: doc.id }, 'Embedding failed');
      }
    }
    return { indexed, failed };
  }

  /** Fire and forget, for use from a request handler. */
  scheduleIndexing(restaurantId: string): void {
    setImmediate(() => {
      this.processPending(restaurantId).catch((error) => {
        logger().error({ err: error, kind: 'embed_job_failed', restaurant_id: restaurantId }, 'Embedding job failed');
      });
    });
  }
}

/** pgvector's text input format: '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
