import { buildTransformer } from "../src/graph/transformer"
import { createGraph } from "../src/graph/neo4j";
import { llm } from "../src/graph/llm";
import { getChunksByDocumentId, cleanChunks } from "../src/graph/chunk";
import { writeChunkGraph } from "../src/graph/store";
import { pool } from "../src/db";
import { takeTenantArg, requireTenant } from "./lib/tenant";

async function main() {
  const { slug, rest } = takeTenantArg(process.argv.slice(2));
  const tenant = await requireTenant(slug);
  const docId = rest[0];
  const limit = Number(rest[1] ?? 5);

  const chunks = await getChunksByDocumentId(tenant.id, docId);
  const cleanedDocs = cleanChunks(chunks.slice(0, limit));

  const transformer = buildTransformer(
    ["Regulation", "Organization", "Obligation", "Process"],
    ["REGULATES", "BASED_ON", "OBLIGATES"]
  );
  const start = Date.now();
  const graphDocs = await transformer.convertToGraphDocuments(cleanedDocs);
  const seconds = (Date.now() - start) / 1000;
  const perChunk = seconds / cleanedDocs.length;
  console.log(`${perChunk.toFixed(1)}s per chunk, full run ≈ ${((perChunk * 1010) / 3600).toFixed(1)} hours`);

  for (const idx in graphDocs) {
    const gd = graphDocs[idx];
    const chunk = cleanedDocs[idx];

    console.log("--- Chunk ---");
    console.log(`Chunk ID: ${chunk.metadata.chunkId}`)
    console.log(`Page: ${chunk.metadata.pageNumber}`)
    console.log(`Content: ${chunk.pageContent.slice(0, 100)}...\n`);

    for (const node of gd.nodes) {
      console.log(`Node: ${node.id}, Type: ${node.type}`);
    }
    for (const rel of gd.relationships) {
      console.log(`Relationship: ${rel.source.id} -[${rel.type}]-> ${rel.target.id}`);
    }
  }
  
  const graph = await createGraph(tenant.neo4j);
  // writeChunkGraph writes into the document's own graph (graphId = document id).
  for (const gd of graphDocs) await writeChunkGraph(graph, gd, docId);
  await graph.close();

  await pool.end();
}

main().catch((err) => { console.error("Failed:", err.message); process.exit(1); });