import { llm } from "../src/graph/llm";

async function main() {
  const start = Date.now();
  const res = await llm.invoke("Jawab singkat: apa kepanjangan OJK?");
  console.log(res.content);
  console.log(`Took ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});