/**
 * GraphRAG "local search" over the POJK knowledge graph.
 *
 *   1. Seed:   embed the query, take the top-N entities from the entity vector index.
 *   2. Expand: walk 1 hop from each seed to neighbouring entities (preferring
 *              specific neighbours over hubs like "Bank").
 *   3. Gather: collect the chunks (:Document) that MENTION any seed/neighbour.
 *   4. Rank:   chunk score = sum over its matched entities of
 *                 weight(entity) / log2(1 + #chunks mentioning that entity)
 *              where weight = seed similarity, or 0.5 x the seed's similarity
 *              for a 1-hop neighbour. Rare, query-relevant entities count most.
 *
 * No LLM call at query time: only one embedding + three Cypher queries.
 */
import neo4j from 'neo4j-driver';
import { config } from '../config';
import { embeddings } from '../vectorstore';
import { getGraph, ENTITY_INDEX, ENTITY_LABEL } from './neo4j';

const NEIGHBOR_DECAY = 0.5;

export interface SeedEntity {
  id: string;
  type: string | null;
  score: number; // cosine similarity, higher = closer
}

export interface GraphHit {
  id: string; // same id as document_chunks.id
  documentId: string;
  filename: string;
  text: string;
  score: number;
  entities: string[]; // matched entities in this chunk, best first
}

export interface GraphRetrieval {
  hits: GraphHit[];
  seeds: SeedEntity[];
  facts: string[]; // "(A) -[REL]-> (B)" edges connecting the matched entities
}

export interface GraphRetrieveOptions {
  seedEntities?: number;
  maxNeighbors?: number;
}

export async function graphRetrieve(
  query: string,
  k: number,
  opts: GraphRetrieveOptions = {}
): Promise<GraphRetrieval> {
  const seedEntities = opts.seedEntities ?? config.graphSeedEntities;
  const maxNeighbors = opts.maxNeighbors ?? config.graphMaxNeighbors;
  const graph = await getGraph();

  // 1. Seed entities
  const vector = await embeddings.embedQuery(query);
  const seeds = await graph.query<SeedEntity>(
    `CALL db.index.vector.queryNodes($index, $n, $vector) YIELD node, score
     RETURN node.id AS id, [l IN labels(node) WHERE l <> '${ENTITY_LABEL}'][0] AS type, score`,
    // JS numbers reach Cypher as floats; the index size must be an integer.
    { index: ENTITY_INDEX, n: neo4j.int(seedEntities), vector }
  );
  if (seeds.length === 0) return { hits: [], seeds, facts: [] };

  // 2. One-hop expansion, least-mentioned (most specific) neighbours first
  const edges = await graph.query<{ seed: string; nbr: string; rel: string; src: string; dst: string }>(
    `UNWIND $seeds AS seedId
     MATCH (s:${ENTITY_LABEL} {id: seedId})-[r]-(n:${ENTITY_LABEL})
     WITH seedId, r, n, COUNT { (n)<-[:MENTIONS]-(:Document) } AS df
     ORDER BY df ASC
     WITH seedId, collect({nbr: n.id, rel: type(r), src: startNode(r).id, dst: endNode(r).id})[0..$maxNeighbors] AS rows
     UNWIND rows AS row
     RETURN seedId AS seed, row.nbr AS nbr, row.rel AS rel, row.src AS src, row.dst AS dst`,
    { seeds: seeds.map((s) => s.id), maxNeighbors: neo4j.int(maxNeighbors) }
  );

  const weight = new Map<string, number>();
  for (const s of seeds) weight.set(s.id, s.score);
  const seedScore = new Map(seeds.map((s) => [s.id, s.score]));
  for (const e of edges) {
    const w = NEIGHBOR_DECAY * (seedScore.get(e.seed) ?? 0);
    if ((weight.get(e.nbr) ?? 0) < w) weight.set(e.nbr, w);
  }

  // 3. Chunks mentioning any matched entity, with each entity's document frequency
  const rows = await graph.query<{
    id: string;
    documentId: string;
    filename: string;
    text: string;
    ents: { id: string; df: number }[];
  }>(
    `UNWIND $ids AS entId
     MATCH (e:${ENTITY_LABEL} {id: entId})<-[:MENTIONS]-(d:Document)
     WITH d, e, COUNT { (e)<-[:MENTIONS]-(:Document) } AS df
     RETURN d.id AS id, d.documentId AS documentId, d.filename AS filename, d.text AS text,
            collect({id: e.id, df: df}) AS ents`,
    { ids: [...weight.keys()] }
  );

  // 4. Rank
  const hits: GraphHit[] = rows
    .map((r) => {
      const scored = r.ents
        .map((e) => ({ id: e.id, s: (weight.get(e.id) ?? 0) / Math.log2(1 + Number(e.df)) }))
        .sort((a, b) => b.s - a.s);
      return {
        id: r.id,
        documentId: r.documentId,
        filename: r.filename,
        text: r.text,
        score: scored.reduce((sum, e) => sum + e.s, 0),
        entities: scored.map((e) => e.id),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Facts = expansion edges whose both ends appear in the returned chunks
  const inHits = new Set(hits.flatMap((h) => h.entities));
  const facts = [
    ...new Set(
      edges
        .filter((e) => inHits.has(e.src) && inHits.has(e.dst))
        .map((e) => `(${e.src}) -[${e.rel}]-> (${e.dst})`)
    ),
  ];

  return { hits, seeds, facts };
}
