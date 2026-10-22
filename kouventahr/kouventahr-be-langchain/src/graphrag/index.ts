/**
 * Builds the knowledge graph from the chunks already in Postgres
 * (document_chunks), so graph and vector retrieval work on identical chunks.
 *
 *   npm run graph:index                      # all chunks not yet in the graph
 *   npm run graph:index -- --limit 20        # just the next 20 (quality check)
 *   npm run graph:index -- --doc <id>        # only one uploaded document
 *   npm run graph:index -- --embed-only      # just (re)embed entities missing an embedding
 *   npm run graph:index -- --reset ...       # wipe the whole graph first (e.g. after changing the prompt)
 *
 * Resumable: chunks already in Neo4j are skipped, so Ctrl+C and re-run is safe.
 * Chunks whose extraction fails are logged to graphrag-failures.log and
 * retried on the next run.
 */
import fs from 'fs';
import path from 'path';
import { Document } from '@langchain/core/documents';
import { ChatOllama } from '@langchain/ollama';
import { LLMGraphTransformer } from '@langchain/community/experimental/graph_transformers/llm';
import { GraphDocument, Node, Relationship } from '@langchain/community/graphs/document';
import { config } from '../config';
import { pool } from '../db';
import { embeddings } from '../vectorstore';
import { getGraph, ensureIndexes, ENTITY_LABEL } from './neo4j';
import {
  ALLOWED_NODES,
  ALLOWED_RELATIONSHIPS,
  EXTRACTION_PROMPT,
  extractionInput,
  normalizeId,
  regulationFromFilename,
  qualifyPasal,
  entityKey,
} from './schema';

const FAILURE_LOG = path.join(__dirname, '..', '..', 'graphrag-failures.log');
const EMBED_BATCH = 64;

interface ChunkRow {
  id: string;
  content: string;
  documentId: string;
  filename: string;
}

function parseArgs(argv: string[]) {
  const args = { limit: Infinity, doc: undefined as string | undefined, embedOnly: false, reset: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--doc') args.doc = argv[++i];
    else if (argv[i] === '--embed-only') args.embedOnly = true;
    else if (argv[i] === '--reset') args.reset = true;
  }
  return args;
}

async function loadChunks(doc?: string): Promise<ChunkRow[]> {
  const { rows } = await pool.query<ChunkRow>(
    `SELECT id::text AS id, content,
            metadata->>'documentId' AS "documentId",
            metadata->>'filename'   AS filename
       FROM document_chunks
      ${doc ? `WHERE metadata->>'documentId' = $1` : ''}
      ORDER BY metadata->>'filename', id`,
    doc ? [doc] : []
  );
  return rows;
}

/**
 * Cleans one extraction before it is written:
 *  - normalizes whitespace and qualifies bare "Pasal N" with the chunk's regulation
 *  - maps ids case-insensitively onto entities that already exist in the graph
 *    (and onto the first spelling seen within this chunk)
 *  - adds relationship endpoints the model forgot to list as nodes, so they keep a type
 *  - drops empty ids, self-loops and duplicate edges
 *  - swaps the LLM input ("Sumber dokumen: ..." + text) back to the raw chunk
 */
async function cleanGraphDocument(gd: GraphDocument, chunk: ChunkRow): Promise<GraphDocument> {
  const regulation = regulationFromFilename(chunk.filename);
  const clean = (id: string | number) => qualifyPasal(normalizeId(id), regulation);

  const rawIds = [
    ...gd.nodes.map((n) => clean(n.id)),
    ...gd.relationships.flatMap((r) => [clean(r.source.id), clean(r.target.id)]),
  ].filter((id) => id !== '');

  // Canonical spelling per key: existing graph entity first, else first seen in this chunk.
  const canonical = new Map<string, string>();
  const existing = await (await getGraph()).query<{ key: string; id: string }>(
    `UNWIND $keys AS k MATCH (e:${ENTITY_LABEL} {key: k}) RETURN e.key AS key, e.id AS id`,
    { keys: [...new Set(rawIds.map(entityKey))] }
  );
  for (const e of existing) canonical.set(e.key, e.id);
  for (const id of rawIds) if (!canonical.has(entityKey(id))) canonical.set(entityKey(id), id);
  const resolve = (id: string | number) => canonical.get(entityKey(clean(id))) ?? '';

  const nodesById = new Map<string, Node>();
  const addNode = (n: Node) => {
    const id = resolve(n.id);
    if (id && !nodesById.has(id)) nodesById.set(id, new Node({ id, type: n.type, properties: n.properties }));
  };
  gd.nodes.forEach(addNode);

  const seenEdges = new Set<string>();
  const relationships: Relationship[] = [];
  for (const r of gd.relationships) {
    addNode(r.source);
    addNode(r.target);
    const source = nodesById.get(resolve(r.source.id));
    const target = nodesById.get(resolve(r.target.id));
    if (!source || !target || source.id === target.id) continue;
    const edgeKey = `${source.id}|${r.type}|${target.id}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    relationships.push(new Relationship({ source, target, type: r.type, properties: r.properties }));
  }

  return new GraphDocument({
    nodes: [...nodesById.values()],
    relationships,
    source: new Document({
      pageContent: chunk.content,
      metadata: { id: chunk.id, documentId: chunk.documentId, filename: chunk.filename },
    }),
  });
}

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

async function extractChunks(chunks: ChunkRow[]): Promise<void> {
  const graph = await getGraph();
  const transformer = new LLMGraphTransformer({
    llm: new ChatOllama({ model: config.graphExtractModel, baseUrl: config.ollamaHost, temperature: 0 }),
    allowedNodes: ALLOWED_NODES,
    allowedRelationships: ALLOWED_RELATIONSHIPS,
    prompt: EXTRACTION_PROMPT,
    strictMode: true,
  });

  const started = Date.now();
  let failed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const t0 = Date.now();
    try {
      const raw = await transformer.processResponse(
        new Document({ pageContent: extractionInput(chunk.filename, chunk.content) })
      );
      const gd = await cleanGraphDocument(raw, chunk);
      // Writes the chunk as (:Document) even when nothing was extracted, which marks it as done.
      await graph.addGraphDocuments([gd], { baseEntityLabel: true, includeSource: true });
      await graph.query(
        `UNWIND $ids AS id MATCH (e:${ENTITY_LABEL} {id: id}) WHERE e.key IS NULL SET e.key = toLower(id)`,
        { ids: gd.nodes.map((n) => String(n.id)) }
      );

      const done = i + 1;
      const eta = ((Date.now() - started) / done) * (chunks.length - done);
      console.log(
        `[${done}/${chunks.length}] ${chunk.filename.slice(0, 45).padEnd(45)} ` +
          `nodes=${String(gd.nodes.length).padStart(2)} rels=${String(gd.relationships.length).padStart(2)} ` +
          `${((Date.now() - t0) / 1000).toFixed(1)}s  ETA ${fmtDuration(eta)}`
      );
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${i + 1}/${chunks.length}] FAILED ${chunk.id} (${chunk.filename}): ${msg.slice(0, 160)}`);
      fs.appendFileSync(FAILURE_LOG, `${new Date().toISOString()}\t${chunk.id}\t${chunk.filename}\t${msg.replace(/\s+/g, ' ')}\n`);
    }
  }

  console.log(`\nExtraction finished in ${fmtDuration(Date.now() - started)}; ${failed} chunk(s) failed${failed ? ` (see ${FAILURE_LOG})` : ''}.`);
}

/** Embeds every entity that has no embedding yet: text = "<name> (<Type>)". */
async function embedEntities(): Promise<void> {
  const graph = await getGraph();
  const pending = await graph.query<{ id: string; type: string | null }>(
    `MATCH (e:${ENTITY_LABEL}) WHERE e.embedding IS NULL
     RETURN e.id AS id, [l IN labels(e) WHERE l <> '${ENTITY_LABEL}'][0] AS type`
  );
  if (pending.length === 0) return;

  console.log(`Embedding ${pending.length} new entities...`);
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vectors = await embeddings.embedDocuments(batch.map((e) => (e.type ? `${e.id} (${e.type})` : e.id)));
    await graph.query(
      `UNWIND $rows AS row
       MATCH (e:${ENTITY_LABEL} {id: row.id})
       CALL db.create.setNodeVectorProperty(e, 'embedding', row.embedding)`,
      { rows: batch.map((e, j) => ({ id: e.id, embedding: vectors[j] })) }
    );
  }
}

async function printStats(): Promise<void> {
  const graph = await getGraph();
  const [stats] = await graph.query(
    `CALL () { MATCH (d:Document) RETURN count(d) AS chunks }
     CALL () { MATCH (e:${ENTITY_LABEL}) RETURN count(e) AS entities }
     CALL () { MATCH (:${ENTITY_LABEL})-[r]->(:${ENTITY_LABEL}) RETURN count(r) AS relations }
     RETURN chunks, entities, relations`
  );
  const { rows } = await pool.query<{ total: string }>('SELECT count(*) AS total FROM document_chunks');
  console.log(
    `Graph: ${stats.chunks}/${rows[0].total} chunks indexed, ${stats.entities} entities, ${stats.relations} relations.`
  );
}

async function main() {
  const { limit, doc, embedOnly, reset } = parseArgs(process.argv.slice(2));
  const graph = await getGraph();
  if (reset) {
    await graph.query('MATCH (n) DETACH DELETE n');
    console.log('Graph wiped.');
  }
  await ensureIndexes();

  if (!embedOnly) {
    const all = await loadChunks(doc);
    const indexed = new Set(
      (await graph.query<{ id: string }>('MATCH (d:Document) RETURN d.id AS id')).map((r) => r.id)
    );
    const pending = all.filter((c) => !indexed.has(c.id)).slice(0, limit);

    console.log(
      `Chunks in scope: ${all.length}, already indexed: ${all.length - all.filter((c) => !indexed.has(c.id)).length}, ` +
        `to index now: ${pending.length}  (model: ${config.graphExtractModel})\n`
    );
    if (pending.length > 0) await extractChunks(pending);
  }

  await embedEntities();
  await printStats();
}

// Explicit exit for the same reason as retrieve_test.ts (open pg / neo4j handles).
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
