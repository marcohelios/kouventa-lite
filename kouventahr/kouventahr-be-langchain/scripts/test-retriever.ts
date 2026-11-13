import { createGraph } from "../src/graph/neo4j";
import { structuredRetriever } from "../src/graph/retriever";
import { takeTenantArg, requireTenant } from "./lib/tenant";

const questions = [
  "Apa saja kebijakan perkreditan atau pembiayaan bank?",
  "Apa saja sanksi terhadap pelanggaran ketentuan", // typo on purpose: tests the ~2 fuzziness
  "apa itu kredit?", // not in the graph: expect an empty result
];

async function main() {
  const tenant = await requireTenant(takeTenantArg(process.argv.slice(2)).slug);
  const graph = await createGraph(tenant.neo4j);
  try {
    for (const q of questions) {
      const start = Date.now();
      const out = await structuredRetriever(graph, q, "Organization, Regulation, Process", { chunkLimit: 3 });
      console.log(`\nQ: ${q}`);
      console.log(`(${((Date.now() - start) / 1000).toFixed(1)}s)`);
      console.log(out.facts || "(no facts)");
      for (const c of out.chunks) console.log(`[chunk ${c.id} hits=${c.hits}] ${c.text.slice(0, 120)}...`);
    }
  } finally {
    await graph.close(); // without this the script hangs
  }
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exitCode = 1;
});