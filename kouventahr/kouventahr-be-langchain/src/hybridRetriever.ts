import { Document } from '@langchain/core/documents';
import { config } from './config/config';
import { getRetriever } from './vectorstore';
import { getGraph } from './graph/neo4j';
import { structuredRetriever, type GraphChunk } from './graph/retriever';
import { formatHybridContext } from './rag';
import type { Tenant } from './tenant/tenants';

export interface HybridResult {
  /** Vector chunks followed by the extra graph-found chunks, de-duplicated (drives `sources`). */
  docs: Document[];
  /** How many of `docs` came only from the graph (chunks the vector search did not return). */
  graphChunks: number;
  /** Graph-found chunks dropped because vector search had already returned them. */
  duplicateChunks: number;
  /** Knowledge-graph triples; empty when the graph found nothing or failed. */
  graphFacts: string[];
  /** False when the graph errored or timed out and we fell back to vector only. */
  graphUsed: boolean;
  /** Final string for the prompt's {context}; '' when nothing was retrieved. */
  context: string;
  vectorMs: number;
  graphMs: number;
}

/** Rejects if `work` has not settled within `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`graph retrieval timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Best-effort graph lookup: never throws, returns nothing + used=false on any failure. */
async function graphFactsSafe(tenant: Tenant, question: string, documentId?: string) {
  const start = Date.now();
  try {
    const signal = AbortSignal.timeout(config.graphTimeoutMs);
    const { facts, chunks } = await withTimeout(
      getGraph(tenant).then((graph) =>
        structuredRetriever(graph, question, config.graphEntityTypes, {
          documentId,
          signal,
          chunkLimit: config.graphChunkK,
        })
      ),
      config.graphTimeoutMs
    );
    return { facts: facts ? facts.split('\n') : [], chunks, used: true, ms: Date.now() - start };
  } catch (err) {
    console.warn('Graph retrieval failed, continuing with vector only:', (err as Error).message);
    return { facts: [] as string[], chunks: [] as GraphChunk[], used: false, ms: Date.now() - start };
  }
}

/**
 * Vector chunks first (they already ranked by similarity), then graph chunks the vector search missed.
 * Both stores use the same chunk id (pgvector row id = Neo4j Document.id), so id equality is the dedupe key.
 */
function mergeChunks(vectorDocs: Document[], graphChunks: GraphChunk[]) {
  const seen = new Set(vectorDocs.map((d) => d.id).filter((id): id is string => !!id));
  const added: Document[] = [];
  let duplicates = 0;
  for (const c of graphChunks) {
    if (seen.has(c.id)) {
      duplicates++;
      continue;
    }
    seen.add(c.id);
    added.push(
      new Document({
        id: c.id,
        pageContent: c.text,
        metadata: { documentId: c.documentId, filename: c.filename, source: 'graph' },
      })
    );
  }
  return { docs: [...vectorDocs, ...added], added: added.length, duplicates };
}

/** Vector search + knowledge-graph facts, run in parallel and merged into one context string. */
export async function hybridRetrieve(tenant: Tenant, question: string, documentId?: string): Promise<HybridResult> {
  const vectorStart = Date.now();
  const [docs, graph] = await Promise.all([
    getRetriever(tenant.id, documentId)
      .invoke(question)
      .then((d) => ({ d, ms: Date.now() - vectorStart })),
    graphFactsSafe(tenant, question, documentId),
  ]);

  const merged = mergeChunks(docs.d, graph.chunks);

  return {
    docs: merged.docs,
    graphChunks: merged.added,
    duplicateChunks: merged.duplicates,
    graphFacts: graph.facts,
    graphUsed: graph.used,
    context: formatHybridContext(graph.facts, merged.docs),
    vectorMs: docs.ms,
    graphMs: graph.ms,
  };
}
