import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph';
import { config } from '../config';

/**
 * Graph layout (written by Neo4jGraph.addGraphDocuments with
 * { baseEntityLabel: true, includeSource: true }):
 *
 *   (:Document {id: <document_chunks.id>, text, documentId, filename})
 *        -[:MENTIONS]-> (:__Entity__:<Type> {id: <name>, key: toLower(id), embedding})
 *   (:__Entity__)-[:MENGATUR|MEWAJIBKAN|...]->(:__Entity__)
 *
 * Note: a "Document" node here is one *chunk* (LangChain's naming), and its id
 * is the same id the vector store uses, so the two retrievers can be compared.
 */
export const ENTITY_LABEL = '__Entity__';
export const ENTITY_INDEX = 'entity_embedding';
export const EMBED_DIMENSIONS = 768; // nomic-embed-text

let graph: Neo4jGraph | undefined;

export async function getGraph(): Promise<Neo4jGraph> {
  if (!graph) {
    graph = await Neo4jGraph.initialize({
      url: config.neo4jUrl,
      username: config.neo4jUser,
      password: config.neo4jPassword,
    });
  }
  return graph;
}

export async function ensureIndexes(): Promise<void> {
  const g = await getGraph();
  await g.query(
    `CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:${ENTITY_LABEL}) REQUIRE e.id IS UNIQUE`
  );
  await g.query(`CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE`);
  // Lower-cased id, used to merge entities that differ only in case.
  await g.query(`CREATE INDEX entity_key IF NOT EXISTS FOR (e:${ENTITY_LABEL}) ON (e.key)`);
  await g.query(
    `CREATE VECTOR INDEX ${ENTITY_INDEX} IF NOT EXISTS
     FOR (e:${ENTITY_LABEL}) ON (e.embedding)
     OPTIONS { indexConfig: {
       \`vector.dimensions\`: ${EMBED_DIMENSIONS},
       \`vector.similarity_function\`: 'cosine'
     } }`
  );
}

export async function closeGraph(): Promise<void> {
  await graph?.close();
  graph = undefined;
}
