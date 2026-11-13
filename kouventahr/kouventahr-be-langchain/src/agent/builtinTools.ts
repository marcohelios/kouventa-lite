import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as db from '../db';
import { hybridRetrieve } from '../hybridRetriever';
import type { Tenant } from '../tenant/tenants';

export interface DocumentSource {
  documentId: string;
  filename: string;
}

export const SEARCH_DOCUMENTS = 'search_documents';
export const LIST_DOCUMENTS = 'list_documents';

/** Semantic + knowledge-graph search over the tenant's uploaded documents. Sources travel as the tool artifact. */
const searchDocuments = (tenant: Tenant) =>
  tool(
  async ({ query, documentId }): Promise<[string, DocumentSource[]]> => {
    const result = await hybridRetrieve(tenant, query, documentId);
    const sources = [
      ...new Map(
        result.docs.map((d) => [
          d.metadata.documentId as string,
          { documentId: d.metadata.documentId as string, filename: d.metadata.filename as string },
        ])
      ).values(),
    ];
    return [result.context || 'No matching document content found.', sources];
  },
  {
    name: SEARCH_DOCUMENTS,
    description:
      'Search the uploaded documents for passages and knowledge-graph facts relevant to a query. ' +
      'Returns document excerpts with their filenames. Optionally restrict to one document by id (see list_documents).',
    schema: z.object({
      query: z.string().describe('What to look for, phrased as a self-contained search query.'),
      documentId: z.string().uuid().optional().describe('Restrict the search to this document id.'),
    }),
    responseFormat: 'content_and_artifact',
  }
);

/** Lets the agent discover what has been uploaded before searching. */
const listDocuments = (tenant: Tenant) =>
  tool(
  async () => {
    const docs = await db.listDocuments(tenant.id);
    if (docs.length === 0) return 'No documents have been uploaded.';
    return JSON.stringify(
      docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        chunks: d.chunkCount,
        uploadedAt: d.createdAt,
        graphStatus: d.graphStatus,
      }))
    );
  },
  {
    name: LIST_DOCUMENTS,
    description: 'List the uploaded documents (id, filename, size). Use the ids to scope search_documents.',
    schema: z.object({}),
  }
);

/** The built-in tools are bound to one tenant, so the model can never reach another tenant's documents. */
export const buildBuiltinTools = (tenant: Tenant) => [searchDocuments(tenant), listDocuments(tenant)];
