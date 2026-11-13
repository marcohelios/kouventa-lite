import { Document } from "@langchain/core/documents";
import { pool } from "../db";

export async function getChunksByDocumentId(tenantId: string, documentId: string): Promise<Document[]> {
  const { rows } = await pool.query(
    `SELECT id, content, metadata FROM document_chunks where metadata->>'tenantId' = $1 and metadata->>'documentId' = $2`,
    [tenantId, documentId]
  )
  return rows.map(
    (r) =>
    new Document({
    pageContent: r.content ?? "",
    metadata: { ...r.metadata, chunkId: r.id},
  })
);
}

/** Strips PDF page markers, collapses whitespace and drops chunks too short to hold entities. */
export function cleanChunks(chunks: Document[]): Document[] {
  return chunks
    .map((chunk) => new Document({
      pageContent: chunk.pageContent.replace(/-- \d+ of \d+ --/g, "").replace(/\s+/g, " ").trim(),
      metadata: chunk.metadata,
    }))
    .filter((chunk) => chunk.pageContent.length > 100);
}
