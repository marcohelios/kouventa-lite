import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph";
import { entityChain } from "./entityChain";

function removeLuceneChars(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ");
}

// Generate a full-text search query for a given string input
function generateFullTextQuery(input: string): string {
  const words = removeLuceneChars(input)
    .split(/\s+/)
    .filter(Boolean);

    if (words.length === 0) {
        return ""
    }

    return words.map((word) => `${word}~2`).join(" AND ");
}

// Every document is its own graph (`graphId` = document id), so one name can exist once per document.
// The full-text index covers all of them, so the hit limit is generous: the graph filter below is applied
// after the index lookup, and a tight limit would let other documents' copies of a name crowd out the scoped one.
export const HIT_LIMIT = 500;

// $graphId = null searches every graph of the tenant: the top 2 DISTINCT names are picked, then facts are
// collected for that name from every graph that has it (identical facts collapse). Otherwise only that
// document's graph is searched.
const ENTITY_MATCH = `
CALL db.index.fulltext.queryNodes('entity', $query, { limit: $limit })
YIELD node, score
WHERE $graphId IS NULL OR node.graphId = $graphId
WITH node.id AS name, max(score) AS best, collect(node) AS nodes
ORDER BY best DESC LIMIT 2
UNWIND nodes AS node
`;

export const NEIGHBORHOOD_QUERY = `${ENTITY_MATCH}
CALL {
  WITH node
  MATCH (node)-[r:!MENTIONS]->(neighbor)
  RETURN node.id + ' - ' + type(r) + ' -> ' + neighbor.id AS output
  UNION
  WITH node
  MATCH (node)<-[r:!MENTIONS]-(neighbor)
  RETURN neighbor.id + ' - ' + type(r) + ' -> ' + node.id AS output
}
RETURN DISTINCT output LIMIT 50
`;

// Source chunks of the matched entities: the :Document nodes that MENTION them. A chunk that mentions
// several matched entities is a stronger hit, so those come first. d.id is the chunk's pgvector row id,
// which is what lets the caller de-duplicate against the vector results.
export const CHUNKS_QUERY = `${ENTITY_MATCH}
MATCH (d:Document {graphId: node.graphId})-[:MENTIONS]->(node)
WITH d, count(DISTINCT node) AS hits
RETURN d.id AS id, d.text AS text, d.documentId AS documentId, d.filename AS filename, hits
ORDER BY hits DESC LIMIT toInteger($chunkLimit)
`;

/** A source chunk reached through the knowledge graph. `id` equals the pgvector row id. */
export interface GraphChunk {
  id: string;
  text: string;
  documentId?: string;
  filename?: string;
  /** How many matched entities this chunk mentions. */
  hits: number;
}

export interface GraphRetrieval {
  /** "A - REL -> B" lines, one per line. */
  facts: string;
  chunks: GraphChunk[];
}

export interface StructuredRetrieverOptions {
  /** Only search this document's graph. */
  documentId?: string;
  /** Aborts the entity-extraction LLM call. */
  signal?: AbortSignal;
  /** Max source chunks to return (0 = facts only). */
  chunkLimit?: number;
}

export async function structuredRetriever(
  graph: Neo4jGraph,
  question: string,
  entityTypes = "none specified",
  { documentId, signal, chunkLimit = 0 }: StructuredRetrieverOptions = {}
): Promise<GraphRetrieval> {
  const { names } = await entityChain.invoke({ entityTypes, question }, { signal });
  const lines = new Set<string>();
  const chunks = new Map<string, GraphChunk>();
  const params = { graphId: documentId ?? null, limit: HIT_LIMIT, chunkLimit };

  const results = await Promise.all(
    names.map(async (name) => {
      const query = generateFullTextQuery(name);
      if (!query) return { facts: [], chunkRows: [] };
      const [facts, chunkRows] = await Promise.all([
        graph.query(NEIGHBORHOOD_QUERY, { ...params, query }),
        chunkLimit > 0 ? graph.query(CHUNKS_QUERY, { ...params, query }) : [],
      ]);
      return { facts, chunkRows };
    })
  );

  for (const { facts, chunkRows } of results) {
    for (const row of facts) {
      if (row?.output) lines.add(row.output);
    }
    for (const row of chunkRows) {
      if (!row?.id || !row.text) continue;
      const hits = Number(row.hits ?? 1); // Neo4jGraph stringifies integers
      const seen = chunks.get(row.id);
      if (seen) {
        seen.hits += hits; // reached through more than one extracted name
      } else {
        chunks.set(row.id, { id: row.id, text: row.text, documentId: row.documentId, filename: row.filename, hits });
      }
    }
  }

  return {
    facts: [...lines].join("\n"),
    chunks: [...chunks.values()].sort((a, b) => b.hits - a.hits).slice(0, chunkLimit),
  };
}
