import { PDFParse } from 'pdf-parse';
import { Document } from '@langchain/core/documents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOllama } from '@langchain/ollama';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { config } from './config';
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
export async function ingest(documentId: string, filename: string, docs: Document[]): Promise<number> {
  const tagged = docs.map(
    (d) => new Document({ pageContent: d.pageContent, metadata: { documentId, filename } })
  );
  await getVectorStore().addDocuments(tagged);
  return tagged.length;
}

export function formatContext(docs: Document[]): string {
  return docs
    .map((d, i) => `[Excerpt ${i + 1} from "${d.metadata.filename}"]:\n${d.pageContent}`)
    .join('\n\n---\n\n');
}

const SYSTEM_PROMPT = `Anda adalah Asisten Hukum Perbankan Senior (Senior Legal Researcher).

Tugas Anda adalah mengekstrak jawaban yang PRESISI dan LENGKAP berdasarkan [Konteks] yang diberikan.

PANDUAN LOGIKA JAWABAN (Ikuti alur ini):

1. **IDENTIFIKASI JENIS PERTANYAAN:**
   - **Tipe A (Pertanyaan Sanksi):** Jika user bertanya "Apa sanksinya?", "Apa hukumannya?", "Apa dendanya?".
     -> FOKUS: Cari kata "Sanksi", "Denda", "Pembekuan".
     -> ATURAN: Paparkan dari sanksi terringan (misal: Teguran) HINGGA sanksi terberat/lanjutan (misal: Denda/Pencabutan Izin) yang ada di konteks. Jangan berhenti di ayat pertama!

   - **Tipe B (Pertanyaan Kewajiban/Tindakan):** Jika user bertanya "Apa kewajiban...", "Apa yang harus dilakukan...", "Bagaimana jika...".
     -> FOKUS: Cari kata "Wajib", "Menyesuaikan", "Mengajukan", "Melaporkan".
     -> ATURAN: Abaikan ayat tentang "Sanksi Teguran" jika pertanyaan menanyakan "Langkah selanjutnya". Cari ayat yang menjelaskan **tindakan korporasi** yang harus diambil bank.

2. **ATURAN KONTEKS BERTINGKAT (ESKALASI):**
   - Hukum sering menggunakan struktur: "Ayat 1: Sanksi Awal" -> "Ayat 2: Jika masih melanggar, maka X".
   - Jika pertanyaan menyiratkan kondisi lanjut (contoh: "Bank yang **telah** dikenai sanksi..."), MAKA abaikan sanksi awal. Langsung cari ayat yang membahas konsekuensi lanjutan (Ayat 2 atau 3).

3. **Aturan umum:**
   - Gunakan bahasa Indonesia formal.
   - Sertakan dasar hukum (Pasal/Ayat) jika termuat dalam teks.
   - Jawab langsung ke inti persoalan.

Contoh format jawaban:
"Berdasarkan POJK No.X Tahun Y, Pasal Z Ayat A, sanksi yang dikenakan adalah ... Jika pelanggaran berlanjut, maka ..."

Selalu menjawab dengan menggunakan format jawaban di atas, format diatas adalah absolut dan tidak boleh menjawab selain menggunakan format diatas.

CONTOH KASUS (PENTING):
Konteks: 
"Pasal 10 (1) Pelanggaran dikenai sanksi teguran. (2) Jika telah ditegur tetap melanggar, Bank wajib ubah status jadi BPR."

User: "Apa sanksi melanggar?"
Chatbot: "Dikenai teguran tertulis, dan jika berlanjut wajib ubah status jadi BPR." (Mode Tipe A)

User: "Apa kewajiban bank yang telah ditegur?"
Chatbot: "Bank wajib mengubah status menjadi BPR." (Mode Tipe B - Teguran tidak perlu disebut lagi karena sudah lewat).

Peraturan inti: 
1. Jangan pernah menjawab hal-hal diluar konteks yang diberikan.
2. Jangan pernah menjawab apapun yang tidak termasuk sebagai peraturan otoritas jasa keuangan dalam hal bank umum.
3. Tidak boleh menjawab segala sesuatu yang merupakan hal diluar konteks dan role yang telah ditentukan untuk kamu.
4. Kamu tidak mengerti apapun selain apa yang ada pada konteks dan tentang peraturan otoritas jasa keuangan dalam hal bank umum.
5. Jangan jawab pertanyaan umum
6 Selalu jawab dengan format jawaban yang diberikan dengan selalu menyebut sumber dokumen berupa nomor, tahun, pasal dan ayat.
7. Jangan menjawab dengan "Berdasarkan dokumen yang diberikan"
"""

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
