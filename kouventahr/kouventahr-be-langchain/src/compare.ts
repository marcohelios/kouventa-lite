/**
 * Side-by-side retrieval comparison: vector RAG (PGVectorStore) vs GraphRAG (Neo4j).
 * Retrieval only, no LLM answers.
 *
 *   npm run compare -- "apa sanksi jika bank tidak menyampaikan laporan"
 *   npm run compare -- "..." --k 8 --text
 *   npm run compare -- --file compare/questions.txt     # batch -> compare/results/*.md
 *
 * Flags:
 *   --k <n>      chunks per retriever (default: RETRIEVER_K)
 *   --text       full chunk text instead of a 160-char preview
 *   --file <p>   one question per line (# = comment); writes a markdown report
 */
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { pool } from './db';
import { initVectorStore, getVectorStore } from './vectorstore';
import { getGraph } from './graphrag/neo4j';
import { graphRetrieve } from './graphrag/retriever';

const RESULTS_DIR = path.join(__dirname, '..', 'compare', 'results');

interface Args {
  query: string;
  file?: string;
  k: number;
  text: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { query: '', k: config.retrieverK, text: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = parseInt(argv[++i], 10);
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--text') args.text = true;
    else words.push(a);
  }
  args.query = words.join(' ').trim();
  return args;
}

interface Row {
  id: string;
  filename: string;
  score: string;
  text: string;
  extra?: string;
}

interface Comparison {
  question: string;
  vector: Row[];
  graph: Row[];
  vectorMs: number;
  graphMs: number;
  seeds: string[];
  facts: string[];
  sharedChunks: number;
  sharedFiles: number;
  vectorFiles: number;
  graphFiles: number;
}

async function compareOne(question: string, k: number): Promise<Comparison> {
  let t0 = Date.now();
  const vec = await getVectorStore().similaritySearchWithScore(question, k);
  const vectorMs = Date.now() - t0;

  t0 = Date.now();
  const g = await graphRetrieve(question, k);
  const graphMs = Date.now() - t0;

  const vector: Row[] = vec.map(([d, dist]) => ({
    id: String(d.id),
    filename: d.metadata.filename,
    score: `dist=${dist.toFixed(4)}`,
    text: d.pageContent,
  }));
  const graph: Row[] = g.hits.map((h) => ({
    id: h.id,
    filename: h.filename,
    score: `score=${h.score.toFixed(3)}`,
    text: h.text,
    extra: `via: ${h.entities.slice(0, 5).join(' | ')}${h.entities.length > 5 ? ` (+${h.entities.length - 5})` : ''}`,
  }));

  const vIds = new Set(vector.map((r) => r.id));
  const vFiles = new Set(vector.map((r) => r.filename));
  const gFiles = new Set(graph.map((r) => r.filename));

  return {
    question,
    vector,
    graph,
    vectorMs,
    graphMs,
    seeds: g.seeds.map((s) => `${s.id}${s.type ? ` (${s.type})` : ''} ${s.score.toFixed(3)}`),
    facts: g.facts,
    sharedChunks: graph.filter((r) => vIds.has(r.id)).length,
    sharedFiles: [...gFiles].filter((f) => vFiles.has(f)).length,
    vectorFiles: vFiles.size,
    graphFiles: gFiles.size,
  };
}

const preview = (s: string, full: boolean) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return full || flat.length <= 160 ? flat : flat.slice(0, 160) + '…';
};

/** Markdown section; also readable as plain console output. */
function render(c: Comparison, fullText: boolean, sharedIds: Set<string>): string {
  const out: string[] = [];
  out.push(`## ${c.question}\n`);

  const list = (title: string, rows: Row[], ms: number) => {
    out.push(`### ${title}  (${rows.length} chunks, ${ms} ms)\n`);
    if (rows.length === 0) out.push('_no results_\n');
    rows.forEach((r, i) => {
      const mark = sharedIds.has(r.id) ? ' **[both]**' : '';
      out.push(`${i + 1}. \`${r.score}\` **${r.filename}**${mark}`);
      if (r.extra) out.push(`   - ${r.extra}`);
      out.push(`   - ${preview(r.text, fullText)}`);
    });
    out.push('');
  };

  list('Vector RAG', c.vector, c.vectorMs);
  list('GraphRAG', c.graph, c.graphMs);

  out.push(`**Graph seed entities:** ${c.seeds.join('; ') || '-'}\n`);
  if (c.facts.length) {
    out.push('**Graph facts used:**');
    c.facts.slice(0, 15).forEach((f) => out.push(`- ${f}`));
    if (c.facts.length > 15) out.push(`- … +${c.facts.length - 15} more`);
    out.push('');
  }
  out.push(
    `**Overlap:** ${c.sharedChunks}/${c.graph.length} chunks shared, ` +
      `${c.sharedFiles} file(s) shared (vector: ${c.vectorFiles} files, graph: ${c.graphFiles} files)\n`
  );
  return out.join('\n');
}

async function coverageNote(): Promise<string> {
  const graph = await getGraph();
  const [{ n }] = await graph.query<{ n: number }>('MATCH (d:Document) RETURN count(d) AS n');
  const { rows } = await pool.query<{ total: string }>('SELECT count(*) AS total FROM document_chunks');
  const total = Number(rows[0].total);
  const indexed = Number(n);
  const note = `Graph coverage: ${indexed}/${total} chunks indexed`;
  return indexed < total
    ? `${note} — GraphRAG can only return indexed chunks, so the comparison is partial (run npm run graph:index).`
    : note;
}

async function main() {
  const { query, file, k, text } = parseArgs(process.argv.slice(2));
  if (!query && !file) {
    console.error('Usage: npm run compare -- "question" [--k 5] [--text]   |   npm run compare -- --file compare/questions.txt');
    process.exit(1);
  }

  await initVectorStore();
  const coverage = await coverageNote();

  const questions = file
    ? fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [query];
  if (questions.length === 0) {
    console.error(`No questions found in ${file}.`);
    process.exit(1);
  }

  console.log(`${coverage}\nk=${k}  embed=${config.embedModel}\n`);

  const results: Comparison[] = [];
  const sections: string[] = [];
  for (const q of questions) {
    const c = await compareOne(q, k);
    const shared = new Set(c.graph.filter((g) => c.vector.some((v) => v.id === g.id)).map((g) => g.id));
    const section = render(c, text, shared);
    console.log(section);
    results.push(c);
    sections.push(section);
  }

  if (file) {
    const summary = [
      '| # | Question | Shared chunks | Shared files | Vector ms | Graph ms |',
      '|---|---|---|---|---|---|',
      ...results.map(
        (c, i) =>
          `| ${i + 1} | ${c.question.replace(/\|/g, '\\|')} | ${c.sharedChunks}/${c.graph.length} | ` +
          `${c.sharedFiles} | ${c.vectorMs} | ${c.graphMs} |`
      ),
    ].join('\n');

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outFile = path.join(RESULTS_DIR, `compare-${stamp}.md`);
    fs.writeFileSync(
      outFile,
      `# Vector RAG vs GraphRAG — ${new Date().toLocaleString()}\n\n` +
        `${coverage}  \nk=${k}, embed=${config.embedModel}, seed entities=${config.graphSeedEntities}, ` +
        `max neighbours=${config.graphMaxNeighbors}\n\n## Summary\n\n${summary}\n\n${sections.join('\n---\n\n')}`
    );
    console.log(`Report written to ${outFile}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
