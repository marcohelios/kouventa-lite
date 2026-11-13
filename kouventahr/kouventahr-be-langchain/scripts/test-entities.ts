import { entityChain } from "../src/graph/entityChain";

async function ask(question: string, entityTypes = "none specified") {
  const res = await entityChain.invoke({ entityTypes, question });
  console.log(`Q: ${question}\n   types: ${entityTypes}\n   names:`, res.names, "\n");
}

async function main() {
  await ask("Apa kewajiban Bank Umum dalam menyusun kebijakan perkreditan?", "Organization, Regulation, Process");
  await ask("Apa itu?"); 
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exitCode = 1;
});