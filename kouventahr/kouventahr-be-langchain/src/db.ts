import { Pool } from 'pg';
import { config } from './config/config';

export const pool = new Pool({ connectionString: config.databaseUrl });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export type GraphStatus = 'none' | 'building' | 'done' | 'failed';

export interface DocumentRow {
  id: string;
  filename: string;
  chunkCount: number;
  createdAt: Date;
  graphStatus: GraphStatus;
  graphError: string | null;
  graphBuiltAt: Date | null;
  graphChunksTotal: number;
  graphChunksFailed: number;
}

// Postgres is shared by all tenants, so every query below filters on tenant_id.
// `tenantId` is a required first argument everywhere: a call that forgets it does not compile.

/** The schema comes from db/init.sql; this only repairs state that a restart leaves behind. */
export async function migrate(): Promise<void> {
  // Build jobs live in memory, so a restart orphans any "building" row.
  await pool.query(
    `UPDATE documents SET graph_status = 'failed', graph_error = 'Interrupted (server restarted)'
      WHERE graph_status = 'building'`
  );
}

/** Starter node types a new document begins with; seeded once, when the document is uploaded. */
export async function seedNodeTypes(tenantId: string, documentId: string): Promise<void> {
  for (const name of config.graphDefaultNodeTypes) {
    await pool.query(
      `INSERT INTO graph_node_types (tenant_id, document_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, documentId, name]
    );
  }
}

// Node types are a per-document list: each document's graph has its own types.

/** Saved node types of one document (starter + custom), oldest first. */
export async function listSavedNodeTypes(tenantId: string, documentId: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM graph_node_types WHERE tenant_id = $1 AND document_id = $2 ORDER BY id`,
    [tenantId, documentId]
  );
  return rows.map((r) => r.name);
}

export async function addSavedNodeType(tenantId: string, documentId: string, name: string): Promise<void> {
  await pool.query(`INSERT INTO graph_node_types (tenant_id, document_id, name) VALUES ($1, $2, $3)`, [
    tenantId,
    documentId,
    name,
  ]);
}

/** Renames a saved type; if `to` is already saved (case-insensitively) the two are merged. */
export async function renameSavedNodeType(
  tenantId: string,
  documentId: string,
  from: string,
  to: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clash = await client.query(
      `SELECT 1 FROM graph_node_types
        WHERE tenant_id = $3 AND document_id = $4 AND lower(name) = lower($1) AND lower(name) <> lower($2)`,
      [to, from, tenantId, documentId]
    );
    if (clash.rowCount) {
      await client.query(
        `DELETE FROM graph_node_types WHERE tenant_id = $2 AND document_id = $3 AND lower(name) = lower($1)`,
        [from, tenantId, documentId]
      );
    } else {
      await client.query(
        `UPDATE graph_node_types SET name = $2
          WHERE tenant_id = $3 AND document_id = $4 AND lower(name) = lower($1)`,
        [from, to, tenantId, documentId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteSavedNodeType(tenantId: string, documentId: string, name: string): Promise<void> {
  await pool.query(
    `DELETE FROM graph_node_types WHERE tenant_id = $2 AND document_id = $3 AND lower(name) = lower($1)`,
    [name, tenantId, documentId]
  );
}

const DOCUMENT_COLUMNS = `id, filename, chunk_count AS "chunkCount", created_at AS "createdAt",
       graph_status AS "graphStatus", graph_error AS "graphError", graph_built_at AS "graphBuiltAt",
       graph_chunks_total AS "graphChunksTotal", graph_chunks_failed AS "graphChunksFailed"`;

export async function createDocument(tenantId: string, filename: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO documents (tenant_id, filename) VALUES ($1, $2) RETURNING id',
    [tenantId, filename]
  );
  return rows[0].id;
}

export async function setChunkCount(tenantId: string, id: string, count: number): Promise<void> {
  await pool.query('UPDATE documents SET chunk_count = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, count]);
}

export async function listDocuments(tenantId: string): Promise<DocumentRow[]> {
  const { rows } = await pool.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

export async function getDocument(tenantId: string, id: string): Promise<DocumentRow | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await pool.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rows[0];
}

export interface GraphStatusPatch {
  status: GraphStatus;
  error?: string | null;
  /** Stamp graph_built_at = now(). */
  builtNow?: boolean;
  chunksTotal?: number;
  chunksFailed?: number;
}

export async function setGraphStatus(tenantId: string, id: string, p: GraphStatusPatch): Promise<void> {
  await pool.query(
    `UPDATE documents SET
       graph_status        = $2,
       graph_error         = $3,
       graph_built_at      = CASE WHEN $4 THEN now() WHEN $2 = 'done' THEN graph_built_at ELSE NULL END,
       graph_chunks_total  = COALESCE($5, graph_chunks_total),
       graph_chunks_failed = COALESCE($6, graph_chunks_failed)
     WHERE tenant_id = $7 AND id = $1`,
    [id, p.status, p.error ?? null, p.builtNow ?? false, p.chunksTotal ?? null, p.chunksFailed ?? null, tenantId]
  );
}

/** Returns the number of deleted rows (0 = not found). */
export async function deleteDocument(tenantId: string, id: string): Promise<number> {
  const res = await pool.query('DELETE FROM documents WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return res.rowCount ?? 0;
}

export async function createSession(tenantId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO chat_sessions (tenant_id) VALUES ($1) RETURNING id',
    [tenantId]
  );
  return rows[0].id;
}

export async function sessionExists(tenantId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await pool.query('SELECT 1 FROM chat_sessions WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    id,
  ]);
  return (rowCount ?? 0) > 0;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function getHistory(tenantId: string, sessionId: string, limit = 6): Promise<HistoryMessage[]> {
  const { rows } = await pool.query<{ role: string; content: string }>(
    `SELECT m.role, m.content FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.tenant_id = $3 AND m.session_id = $1 ORDER BY m.created_at ASC LIMIT $2`,
    [sessionId, limit, tenantId]
  );
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
  }));
}

export async function saveMessages(
  tenantId: string,
  sessionId: string,
  userContent: string,
  assistantContent: string
): Promise<void> {
  // The tenant check keeps a foreign session id from being written to.
  if (!(await sessionExists(tenantId, sessionId))) throw new Error('Session not found for this tenant');
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES
       ($1, 'user', $2, now()),
       ($1, 'assistant', $3, now() + interval '1 millisecond')`,
    [sessionId, userContent, assistantContent]
  );
}
