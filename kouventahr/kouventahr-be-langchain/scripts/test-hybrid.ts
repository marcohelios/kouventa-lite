/**
 * Hybrid retrieval debug: prints the exact context string the LLM would receive
 * (graph facts + vector excerpts). No LLM answer, no chat history.
 *
 *   npm run hybrid                                  # runs the sample questions
 *   npm run hybrid -- "apa sanksinya?" --doc <documentId> --tenant <slug>
 */
import { initVectorStore } from "../src/vectorstore";
import { hybridRetrieve } from "../src/hybridRetriever";
import { closeGraph } from "../src/graph/neo4j";
import { takeTenantArg, requireTenant } from "./lib/tenant";

const sampleQuestions = [
  "Apa saja kebijakan perkreditan atau pembiayaan bank?",
  "Apa saja sanksi terhadap pelanggaran ketentuan", // typo on purpose: tests the ~2 fuzziness
  "apa itu kredit?", // not in the graph: expect no graph section
];

function parseArgs(argv: string[]) {
  const args = { question: "", doc: undefined as string | undefined };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--doc") args.doc = argv[++i];
    else words.push(argv[i]);
  }
  args.question = words.join(" ").trim();
  return args;
}

async function main() {
  const { slug, rest } = takeTenantArg(process.argv.slice(2));
  const tenant = await requireTenant(slug);
  const { question, doc } = parseArgs(rest);
  const questions = question ? [question] : sampleQuestions;

  await initVectorStore();

  for (const q of questions) {
    const start = Date.now();
    const r = await hybridRetrieve(tenant, q, doc);
    console.log(`\n=== Q: ${q}`);
    console.log(`scope=${doc ?? "all documents"}  total=${Date.now() - start} ms  vector=${r.vectorMs} ms (${r.docs.length} chunks)  graph=${r.graphMs} ms`);
    console.log(`graphUsed=${r.graphUsed}  graphFacts=${r.graphFacts.length}${r.graphUsed ? "" : "  (FELL BACK to vector only)"}`);
    console.log("--- context sent to the LLM ---");
    console.log(r.context || "(empty)");
  }
}

// Exit explicitly: the pg pool and Neo4j driver can keep the process alive.
main()
  .then(async () => {
    await closeGraph();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
