import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export interface DocumentRow {
  id: string;
  filename: string;
  chunkCount: number;
  createdAt: Date;
}

export async function createDocument(filename: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO documents (filename) VALUES ($1) RETURNING id',
    [filename]
  );
  return rows[0].id;
}

export async function setChunkCount(id: string, count: number): Promise<void> {
  await pool.query('UPDATE documents SET chunk_count = $2 WHERE id = $1', [id, count]);
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count AS "chunkCount", created_at AS "createdAt"
       FROM documents ORDER BY created_at DESC`
  );
  return rows;
}

/** Returns the number of deleted rows (0 = not found). */
export async function deleteDocument(id: string): Promise<number> {
  const res = await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  return res.rowCount ?? 0;
}

export async function createSession(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO chat_sessions DEFAULT VALUES RETURNING id'
  );
  return rows[0].id;
}

export async function sessionExists(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await pool.query('SELECT 1 FROM chat_sessions WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function getHistory(sessionId: string, limit = 6): Promise<HistoryMessage[]> {
  const { rows } = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
      WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [sessionId, limit]
  );
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
  }));
}

export async function saveMessages(
  sessionId: string,
  userContent: string,
  assistantContent: string
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES
       ($1, 'user', $2, now()),
       ($1, 'assistant', $3, now() + interval '1 millisecond')`,
    [sessionId, userContent, assistantContent]
  );
}
