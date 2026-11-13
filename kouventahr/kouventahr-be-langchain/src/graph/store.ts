import { createHash } from "node:crypto";
import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph";
import type { GraphDocument } from "@langchain/community/graphs/document";

/**
 * All Cypher for the knowledge graphs.
 *
 * Every document is its own graph inside the tenant's Neo4j database. Entities, relationships
 * and source-chunk nodes carry `graphId` (= the document id), and an entity is identified by
 * (graphId, id), so the same name in two documents is two separate nodes. Nothing is shared
 * between documents, so an edit or a delete can never touch another document's graph.
 */

export interface GraphNode {
  id: string;
  type: string;
}

export interface GraphEdge {
  /** elementId of the relationship; changes when an edit re-creates it. */
  key: string;
  source: string;
  type: string;
  target: string;
}

export interface DocumentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Neo4jGraph stringifies integers, so counts need Number().
const num = (v: unknown): number => Number(v ?? 0);

/** Chunk metadata that Neo4j can store as a property (primitives only). */
function primitiveMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "id" || key === "graphId" || key === "text") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * Writes one chunk's extraction into the document's graph: the chunk node, its entities (labelled
 * with their type), the MENTIONS links, and the relationships between entities.
 */
export async function writeChunkGraph(
  graph: Neo4jGraph,
  graphDoc: GraphDocument,
  graphId: string
): Promise<void> {
  const source = graphDoc.source;
  // Keyed by the chunk's own id, not a hash of its text, so identical text in two documents stays separate.
  const chunkId = String(source.metadata.chunkId ?? createHash("sha256").update(source.pageContent).digest("hex"));

  await graph.query(
    `MERGE (d:Document {graphId: $graphId, id: $chunkId})
     SET d += $metadata, d.text = $text
     WITH d
     UNWIND $nodes AS row
     MERGE (n:__Entity__ {graphId: $graphId, id: row.id})
     SET n += row.properties
     WITH d, n, row
     CALL apoc.create.addLabels(n, [row.type]) YIELD node
     MERGE (d)-[:MENTIONS]->(node)
     RETURN count(*) AS written`,
    {
      graphId,
      chunkId,
      text: source.pageContent,
      metadata: primitiveMetadata(source.metadata),
      nodes: graphDoc.nodes.map((n) => ({ id: String(n.id), type: n.type, properties: n.properties ?? {} })),
    }
  );

  if (graphDoc.relationships.length === 0) return;
  // A relationship may name an endpoint the LLM left out of `nodes`; MERGE creates it in this graph.
  await graph.query(
    `UNWIND $rels AS row
     MERGE (s:__Entity__ {graphId: $graphId, id: row.source})
     MERGE (t:__Entity__ {graphId: $graphId, id: row.target})
     WITH s, t, row
     CALL apoc.merge.relationship(s, row.type, {graphId: $graphId}, row.properties, t) YIELD rel
     RETURN count(rel) AS written`,
    {
      graphId,
      rels: graphDoc.relationships.map((r) => ({
        source: String(r.source.id),
        target: String(r.target.id),
        // same normalisation LangChain's addGraphDocuments applies to the type
        type: r.type.replace(/ /g, "_").toUpperCase(),
        properties: r.properties ?? {},
      })),
    }
  );
}

/** Removes the whole graph of a document: its entities, relationships and chunk nodes. Idempotent. */
export async function removeDocumentGraph(graph: Neo4jGraph, graphId: string): Promise<void> {
  const params = { graphId };
  await graph.query(`MATCH (n:__Entity__ {graphId: $graphId}) DETACH DELETE n`, params);
  await graph.query(`MATCH (d:Document {graphId: $graphId}) DETACH DELETE d`, params);
}

export async function getDocumentGraph(graph: Neo4jGraph, graphId: string): Promise<DocumentGraph> {
  const params = { graphId };
  const [nodes, edges] = await Promise.all([
    graph.query(
      `MATCH (n:__Entity__ {graphId: $graphId})
       RETURN n.id AS id,
              coalesce([l IN labels(n) WHERE l <> '__Entity__'][0], 'Entity') AS type`,
      params
    ),
    graph.query(
      `MATCH (s:__Entity__ {graphId: $graphId})-[r]->(t:__Entity__ {graphId: $graphId})
       RETURN elementId(r) AS key, s.id AS source, type(r) AS type, t.id AS target`,
      params
    ),
  ]);
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type })),
    edges: edges as GraphEdge[],
  };
}

// ---------------------------------------------------------------- edits ----
// Each edit is ONE statement (= one transaction). `null` / false means "not found in
// this document's graph" so routes can answer 404.

/**
 * Changes an edge's type and/or direction. The old edge is replaced by the new one,
 * and the new key is returned.
 */
export async function updateEdge(
  graph: Neo4jGraph,
  graphId: string,
  key: string,
  patch: { type?: string; reverse?: boolean }
): Promise<string | null> {
  const rows = await graph.query(
    `MATCH (s:__Entity__ {graphId: $graphId})-[r]->(t:__Entity__ {graphId: $graphId})
     WHERE elementId(r) = $key
     WITH r, properties(r) AS props,
          CASE WHEN $reverse THEN t ELSE s END AS ns,
          CASE WHEN $reverse THEN s ELSE t END AS nt,
          coalesce($type, type(r)) AS newType
     CALL apoc.merge.relationship(ns, newType, {graphId: $graphId}, apoc.map.removeKey(props, 'graphId'), nt) YIELD rel
     // merge may have matched the very same edge (nothing changed): never delete that one
     FOREACH (_ IN CASE WHEN elementId(r) <> elementId(rel) THEN [1] ELSE [] END | DELETE r)
     RETURN elementId(rel) AS key`,
    { key, graphId, type: patch.type ?? null, reverse: patch.reverse ?? false }
  );
  return rows[0]?.key ?? null;
}

export async function deleteEdge(graph: Neo4jGraph, graphId: string, key: string): Promise<boolean> {
  const rows = await graph.query(
    `MATCH (:__Entity__ {graphId: $graphId})-[r]->(:__Entity__ {graphId: $graphId})
     WHERE elementId(r) = $key
     DELETE r
     RETURN 1 AS ok`,
    { key, graphId }
  );
  return rows.length > 0;
}

/** Adds an edge, creating either endpoint (with the given type) if it doesn't exist in this graph. */
export async function addEdge(
  graph: Neo4jGraph,
  graphId: string,
  e: { source: string; type: string; target: string; sourceType?: string; targetType?: string }
): Promise<string> {
  const rows = await graph.query(
    `MERGE (s:__Entity__ {graphId: $graphId, id: $source})
     MERGE (t:__Entity__ {graphId: $graphId, id: $target})
     WITH s, t
     CALL apoc.create.addLabels(s, CASE WHEN size([l IN labels(s) WHERE l <> '__Entity__']) = 0 AND $sourceType IS NOT NULL THEN [$sourceType] ELSE [] END) YIELD node AS s2
     CALL apoc.create.addLabels(t, CASE WHEN size([l IN labels(t) WHERE l <> '__Entity__']) = 0 AND $targetType IS NOT NULL THEN [$targetType] ELSE [] END) YIELD node AS t2
     CALL apoc.merge.relationship(s2, $type, {graphId: $graphId}, {}, t2) YIELD rel
     RETURN elementId(rel) AS key`,
    { ...e, sourceType: e.sourceType ?? null, targetType: e.targetType ?? null, graphId }
  );
  return rows[0].key;
}

/**
 * Changes a node's type and/or name within this graph. Renaming onto an existing
 * name in the same graph merges the two nodes.
 */
export async function updateNode(
  graph: Neo4jGraph,
  graphId: string,
  id: string,
  patch: { type?: string; newId?: string }
): Promise<{ id: string } | null> {
  const owned = await graph.query(`MATCH (n:__Entity__ {graphId: $graphId, id: $id}) RETURN 1 AS ok`, { id, graphId });
  if (owned.length === 0) return null;

  let currentId = id;
  if (patch.newId && patch.newId !== id) {
    const target = await graph.query(`MATCH (t:__Entity__ {graphId: $graphId, id: $newId}) RETURN 1 AS ok`, {
      newId: patch.newId,
      graphId,
    });
    if (target.length === 0) {
      await graph.query(`MATCH (n:__Entity__ {graphId: $graphId, id: $id}) SET n.id = $newId`, {
        id,
        newId: patch.newId,
        graphId,
      });
    } else {
      // Merge n into the existing node; keep the target's properties and type.
      await graph.query(
        `MATCH (n:__Entity__ {graphId: $graphId, id: $id}), (t:__Entity__ {graphId: $graphId, id: $newId})
         WITH n, t, [l IN labels(t) WHERE l <> '__Entity__'] AS tl
         CALL apoc.refactor.mergeNodes([t, n], {properties: {\`.*\`: 'discard'}, mergeRels: true}) YIELD node
         CALL apoc.create.setLabels(node, ['__Entity__'] + tl) YIELD node AS m
         RETURN 1 AS ok`,
        { id, newId: patch.newId, graphId }
      );
    }
    currentId = patch.newId;
  }

  if (patch.type) {
    await graph.query(
      `MATCH (n:__Entity__ {graphId: $graphId, id: $id})
       CALL apoc.create.setLabels(n, ['__Entity__', $type]) YIELD node RETURN 1 AS ok`,
      { id: currentId, type: patch.type, graphId }
    );
  }
  return { id: currentId };
}

/** Deletes the node and its edges from this graph. */
export async function deleteNode(graph: Neo4jGraph, graphId: string, id: string): Promise<boolean> {
  const rows = await graph.query(
    `MATCH (n:__Entity__ {graphId: $graphId, id: $id})
     DETACH DELETE n
     RETURN 1 AS ok`,
    { id, graphId }
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------- types ----
// A node's type is its label next to `__Entity__`. Source chunks are also :Document
// nodes, so every query here is limited to `__Entity__` nodes.

export interface TypeUsage {
  name: string;
  nodes: number;
}

/** Every node type in use in this document's graph. */
export async function getTypeUsage(graph: Neo4jGraph, graphId: string): Promise<TypeUsage[]> {
  const rows = await graph.query(
    `MATCH (n:__Entity__ {graphId: $graphId})
     UNWIND [l IN labels(n) WHERE l <> '__Entity__'] AS type
     RETURN type AS name, count(n) AS nodes`,
    { graphId }
  );
  return rows.map((r) => ({ name: r.name, nodes: num(r.nodes) }));
}

/** Relabels every entity of type `from` in this graph to `to` (merging if `to` is already in use). Returns how many. */
export async function renameNodeLabel(graph: Neo4jGraph, graphId: string, from: string, to: string): Promise<number> {
  const rows = await graph.query(
    `MATCH (n:__Entity__ {graphId: $graphId}) WHERE $from IN labels(n)
     WITH collect(n) AS nodes
     WHERE size(nodes) > 0
     CALL apoc.refactor.rename.label($from, $to, nodes) YIELD committedOperations
     RETURN size(nodes) AS moved`,
    { from, to, graphId }
  );
  return num(rows[0]?.moved);
}

/** Which of these entity ids already exist in this graph. */
export async function existingEntityIds(graph: Neo4jGraph, graphId: string, ids: string[]): Promise<Set<string>> {
  const rows = await graph.query(`MATCH (n:__Entity__ {graphId: $graphId}) WHERE n.id IN $ids RETURN n.id AS id`, {
    ids,
    graphId,
  });
  return new Set(rows.map((r) => r.id as string));
}
