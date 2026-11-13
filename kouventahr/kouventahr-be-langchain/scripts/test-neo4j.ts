// scripts/test-neo4j.ts
import { createGraph } from "../src/graph/neo4j";
import { takeTenantArg, requireTenant } from "./lib/tenant";

async function main() {
  console.log("Connecting to Neo4j...");
  const tenant = await requireTenant(takeTenantArg(process.argv.slice(2)).slug);
  const graph = await createGraph(tenant.neo4j);
  console.log("Connected.");

  const result = await graph.query("RETURN 1 AS ok");
  console.log("Query result:", result);

  await graph.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Connection failed:", err.message);
  process.exit(1);
});