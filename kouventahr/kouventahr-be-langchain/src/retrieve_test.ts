/**
 * Retrieval-only test: embeds a query and prints which chunks/files the
 * vector store returns. No LLM, no chat history.
 *
 *   npm run retrieve -- "apa itu bank"
 *   npm run retrieve -- "apa itu bank" --tenant <tenantId> --k 10 --doc <documentId> --text
 *
 * Flags:
 *   --k <n>      number of chunks (default: RETRIEVER_K)
 *   --tenant <id> tenant id (uuid from the tenants table); required
 *   --doc <id>   restrict to one document
 *   --text       print the full chunk text instead of a 120-char preview
 *
 * Score is cosine DISTANCE (0 = identical, lower = more similar).
 */
import { config } from './config/config';
import { initVectorStore, getVectorStore } from './vectorstore';

function parseArgs(argv: string[]) {
  const args = {
    query: '',
    k: config.retrieverK,
    doc: undefined as string | undefined,
    tenant: undefined as string | undefined,
    text: false,
  };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = parseInt(argv[++i], 10);
    else if (a === '--doc') args.doc = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--text') args.text = true;
    else words.push(a);
  }
  args.query = words.join(' ').trim();
  return args;
}

async function main() {
  const { query, k, doc, tenant, text } = parseArgs(process.argv.slice(2));
  if (!query || !tenant) {
    console.error('Usage: npm run retrieve -- "your question" --tenant <tenantId> [--k 5] [--doc <documentId>] [--text]');
    process.exit(1);
  }

  await initVectorStore();

  console.log(`Query : ${query}`);
  console.log(`Model : ${config.embedModel}   k=${k}   scope=${doc ?? 'all documents'}\n`);

  const t0 = Date.now();
  const results = await getVectorStore().similaritySearchWithScore(
    query,
    k,
    doc ? { tenantId: tenant, documentId: doc } : { tenantId: tenant }
  );
  const ms = Date.now() - t0;

  if (results.length === 0) {
    console.log('No chunks returned.');
  }

  results.forEach(([d, score], i) => {
    const body = d.pageContent.replace(/\s+/g, ' ').trim();
    console.log(`#${i + 1}  dist=${score.toFixed(4)}  ${d.metadata.filename}`);
    console.log(`    documentId: ${d.metadata.documentId}`);
    console.log(`    ${text ? body : body.slice(0, 120) + (body.length > 120 ? '…' : '')}\n`);
  });

  const files = [...new Set(results.map(([d]) => d.metadata.filename))];
  console.log(`Retrieved ${results.length} chunks from ${files.length} file(s) in ${ms} ms:`);
  files.forEach((f) => console.log(`  - ${f}`));
}

// Exit explicitly: pool.end() can wait forever on a connection the vector
// store never releases, which would leave this one-shot script hanging.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
