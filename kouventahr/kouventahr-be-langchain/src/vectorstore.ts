import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from './config';
import { pool } from './db';

export const embeddings = new OllamaEmbeddings({
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

/** Standard LangChain retriever, optionally scoped to a single document. */
export function getRetriever(documentId?: string) {
  return vectorStore.asRetriever({
    k: config.retrieverK,
    filter: documentId ? { documentId } : undefined,
  });
}

export async function deleteChunks(documentId: string): Promise<void> {
  await vectorStore.delete({ filter: { documentId } });
}
