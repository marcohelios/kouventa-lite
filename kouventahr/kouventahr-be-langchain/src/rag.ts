import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOllama } from '@langchain/ollama';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { config } from './config/config';
import { getVectorStore } from './vectorstore';

/** Extracts PDF text and splits it into overlapping chunks. */
export async function splitPdf(buffer: Buffer): Promise<Document[]> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });
  const docs = await splitter.createDocuments([result.text]);
  return docs.filter((d) => d.pageContent.trim().length > 0);
}

/** Tags chunks with their parent document and embeds them into the vector store. */
export async function ingest(tenantId: string, documentId: string, filename: string, docs: Document[]): Promise<number> {
  const tagged = docs.map(
    (d) => new Document({ pageContent: d.pageContent, metadata: { tenantId, documentId, filename } })
  );
  await getVectorStore().addDocuments(tagged);
  return tagged.length;
}

export function formatContext(docs: Document[]): string {
  return docs
    .map((d, i) => `[Excerpt ${i + 1} from "${d.metadata.filename}"]:\n${d.pageContent}`)
    .join('\n\n---\n\n');
}

/** Context string for the LLM: graph facts (if any) followed by the vector excerpts. */
export function formatHybridContext(facts: string[], docs: Document[]): string {
  const sections: string[] = [];
  if (facts.length > 0) {
    sections.push(`## Knowledge Graph Facts\n${facts.join('\n')}`);
  }
  if (docs.length > 0) {
    sections.push(`## Document Excerpts\n${formatContext(docs)}`);
  }
  return sections.join('\n\n');
}

const SYSTEM_PROMPT = `You are a Senior Legal Researcher specialising in Indonesian banking law (OJK regulations for commercial banks).

Your task is to extract PRECISE and COMPLETE answers from the [Context] provided.

## Context format
The [Context] may contain two sections:
- "Knowledge Graph Facts": lines of the form "Entity A - RELATIONSHIP -> Entity B", extracted from the regulations. Use them to understand how regulations, organisations, obligations and processes relate, and to locate the relevant articles.
- "Document Excerpts": verbatim text from the regulation documents.
Always take legal wording and citations (regulation number, year, Article, Paragraph) from the Document Excerpts. Never cite a Knowledge Graph Fact as if it were statutory text. If the two sections conflict, the Document Excerpts win.

## Answer logic (follow this flow)
1. **Identify the question type**
   - **Type A (sanction question)**: the user asks "What is the sanction?", "What is the penalty?", "What is the fine?" (Indonesian: "Apa sanksinya?", "Apa hukumannya?", "Apa dendanya?").
     -> FOCUS: look for "Sanksi", "Denda", "Pembekuan".
     -> RULE: present sanctions from the lightest (e.g. a reprimand) UP TO the heaviest/follow-up sanction (e.g. a fine or licence revocation) found in the context. Do not stop at the first paragraph.
   - **Type B (obligation/action question)**: the user asks "What is the obligation...", "What must be done...", "What if..." (Indonesian: "Apa kewajiban...", "Apa yang harus dilakukan...", "Bagaimana jika...").
     -> FOCUS: look for "Wajib", "Menyesuaikan", "Mengajukan", "Melaporkan".
     -> RULE: ignore paragraphs about reprimand sanctions when the question asks for the "next step". Find the paragraph describing the **corporate action** the bank must take.

2. **Tiered (escalation) context**
   - Regulations often follow "Paragraph 1: initial sanction" -> "Paragraph 2: if the violation continues, then X".
   - If the question implies a later stage (e.g. "A bank that **has already** been sanctioned..."), ignore the initial sanction and go straight to the paragraph describing the follow-up consequence (Paragraph 2 or 3).

3. **General rules**
   - Reply in the same language as the user's question (Indonesian question -> Indonesian answer, English question -> English answer), in a formal register.
   - Include the legal basis (Article/Paragraph) whenever it appears in the text.
   - Answer the core of the question directly.

## Answer format (mandatory)
Indonesian: "Berdasarkan POJK No.X Tahun Y, Pasal Z Ayat A, sanksi yang dikenakan adalah ... Jika pelanggaran berlanjut, maka ..."
English: "Based on POJK No.X of Year Y, Article Z Paragraph A, the sanction imposed is ... If the violation continues, then ..."
Always answer in this format. It is absolute; never answer in any other format.

## Example (important)
Context:
"Pasal 10 (1) Pelanggaran dikenai sanksi teguran. (2) Jika telah ditegur tetap melanggar, Bank wajib ubah status jadi BPR."

User: "Apa sanksi melanggar?"
Assistant: "Dikenai teguran tertulis, dan jika berlanjut wajib ubah status jadi BPR." (Type A)

User: "Apa kewajiban bank yang telah ditegur?"
Assistant: "Bank wajib mengubah status menjadi BPR." (Type B - the reprimand is not repeated because it has already happened.)

## Core rules
1. Never answer anything outside the provided context.
2. Never answer anything that is not an OJK regulation concerning commercial banks.
3. Never answer anything outside the context and the role assigned to you.
4. You know nothing except what is in the context and OJK regulations concerning commercial banks.
5. Do not answer general questions.
6. Always use the answer format above and always cite the source document by number, year, Article and Paragraph.
7. Never say "Based on the provided document" (or "Berdasarkan dokumen yang diberikan").

[Context]
{context}`;

const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM_PROMPT],
  new MessagesPlaceholder('history'),
  ['human', '{question}'],
]);

const llm = new ChatOllama({
  model: config.chatModel,
  baseUrl: config.ollamaHost,
});

/** prompt -> local LLM -> plain string tokens. Input: { context, history, question } */
export const chain = prompt.pipe(llm).pipe(new StringOutputParser());
