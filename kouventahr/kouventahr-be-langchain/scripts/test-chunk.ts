import { getChunksByDocumentId } from "../src/graph/chunk";
import { pool } from "../src/db";
import { takeTenantArg, requireTenant } from "./lib/tenant";

async function main() {
  const { slug, rest } = takeTenantArg(process.argv.slice(2));
  const docId = rest[0];
  if (!docId) throw new Error("Usage: npx tsx scripts/test-chunk.ts <documentId> --tenant <slug>");
  const tenant = await requireTenant(slug);

  const chunks = await getChunksByDocumentId(tenant.id, docId);
  console.log("Chunk count:", chunks.length);
  console.log("First chunk metadata:", chunks[0]?.metadata);
  console.log("First chunk text:", chunks[0]?.pageContent.slice(0, 200));

  await pool.end(); // without this the script hangs
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});