import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from './config/config';
import { pool } from './db';

const embeddings = new OllamaEmbeddings({
  model: config.embedModel,
  baseUrl: config.ollamaHost,
});

let vectorStore: PGVectorStore;

/** Creates the `document_chunks` table (if needed) and connects the store. */
export async function initVectorStore(): Promise<void> {
  vectorStore = await PGVectorStore.initialize(embeddings, {
    pool,
    tableName: 'document_chunks',
    columns: {
      idColumnName: 'id',
      vectorColumnName: 'embedding',
      contentColumnName: 'content',
      metadataColumnName: 'metadata',
    },
    distanceStrategy: 'cosine',
  });
}

export const getVectorStore = () => vectorStore;

/** Standard LangChain retriever for one tenant, optionally scoped to a single document. */
export function getRetriever(tenantId: string, documentId?: string) {
  return vectorStore.asRetriever({
    k: config.retrieverK,
    // tenantId is always part of the filter, so one tenant's chunks can never be returned to another.
    filter: documentId ? { tenantId, documentId } : { tenantId },
  });
}

export async function deleteChunks(tenantId: string, documentId: string): Promise<void> {
  await vectorStore.delete({ filter: { tenantId, documentId } });
}
