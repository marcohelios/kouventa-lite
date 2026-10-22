import { ChatPromptTemplate } from '@langchain/core/prompts';

/**
 * Knowledge-graph schema for POJK (OJK banking regulation) text.
 * LLMGraphTransformer constrains the model to these labels (strict mode),
 * which keeps an 8B model's output consistent enough to hop over.
 */
export const ALLOWED_NODES = [
  'Regulasi', // a regulation: "POJK 12/2021", "UU Perbankan"
  'Pasal', // an article, qualified by its regulation: "POJK 12/2021 Pasal 10"
  'Lembaga', // institution / party: "Bank", "OJK", "Direksi", "Dewan Komisaris"
  'Kewajiban', // an obligation: "menyampaikan laporan publikasi triwulanan"
  'Sanksi', // a sanction: "teguran tertulis", "denda", "pembekuan kegiatan usaha"
  'Istilah', // a defined term / concept: "Layanan Digital", "Laporan Keuangan"
  'Dokumen', // a report / document / form: "Laporan Tahunan", "Rencana Bisnis Bank"
];

export const ALLOWED_RELATIONSHIPS = [
  'MENGATUR', // Regulasi/Pasal -> anything it governs
  'MEWAJIBKAN', // Pasal/Regulasi -> Kewajiban, or Lembaga -> Kewajiban
  'BERLAKU_UNTUK', // Kewajiban/Sanksi -> Lembaga it applies to
  'MENGENAKAN_SANKSI', // Pasal/Lembaga(OJK) -> Sanksi
  'MENDEFINISIKAN', // Pasal -> Istilah
  'MERUJUK', // Pasal -> Pasal/Regulasi it references ("sebagaimana dimaksud dalam ...")
  'BAGIAN_DARI', // Pasal -> Regulasi
  'MENYAMPAIKAN', // Lembaga -> Dokumen
  'MENCABUT', // Regulasi -> Regulasi it revokes / replaces
];

const SYSTEM = `Anda adalah sistem ekstraksi knowledge graph untuk teks peraturan perbankan Indonesia (POJK / OJK).

Ekstrak entitas (nodes) dan hubungan (relationships) yang DISEBUTKAN SECARA EKSPLISIT di teks. Jangan menambah informasi dari luar teks.

ATURAN ID NODE:
- Gunakan nama yang dapat dibaca manusia, dalam Bahasa Indonesia, persis seperti di teks (jangan diterjemahkan).
- Gunakan bentuk paling lengkap dan konsisten. Contoh: "Otoritas Jasa Keuangan" ditulis "OJK"; "Bank Umum" tetap "Bank Umum".
- Regulasi ditulis "POJK <nomor>/<tahun>", contoh: "POJK 12/2021".
- Pasal SELALU diawali regulasinya, contoh: "POJK 12/2021 Pasal 10". Jika regulasi tidak disebut di teks, gunakan regulasi dari "Sumber dokumen".
- Kewajiban dan Sanksi ditulis sebagai frasa pendek (maksimal ~8 kata), contoh: "teguran tertulis", "menyampaikan laporan publikasi triwulanan".
- Jangan gunakan angka saja sebagai ID.

TIPE NODE (pilih yang paling tepat):
- Regulasi  : peraturan/undang-undang. Contoh: "POJK 42/2017", "UU 21/2011". BUKAN lembaga, BUKAN pasal.
- Pasal     : pasal dalam regulasi, selalu dengan prefiks regulasinya. Contoh: "POJK 42/2017 Pasal 7".
- Lembaga   : institusi, organ, atau pihak. Contoh: "OJK", "Bank", "Bank Umum", "Direksi", "Dewan Komisaris", "Unit Usaha Syariah".
- Kewajiban : tindakan yang WAJIB dilakukan. Contoh: "menyusun kebijakan perkreditan", "menyampaikan laporan tahunan".
- Sanksi    : hukuman/sanksi. Contoh: "teguran tertulis", "denda", "pembekuan kegiatan usaha".
- Istilah   : konsep/istilah yang didefinisikan atau dibahas. Contoh: "Kredit", "Pembiayaan", "Layanan Digital".
- Dokumen   : laporan, rencana, pedoman, atau formulir. Contoh: "Laporan Publikasi", "Rencana Bisnis Bank".

TIPE RELATIONSHIP (arah: sumber -> target):
- BAGIAN_DARI       : Pasal -> Regulasi. ("POJK 42/2017 Pasal 7" BAGIAN_DARI "POJK 42/2017")
- MENGATUR          : Regulasi/Pasal -> Istilah/Lembaga/Dokumen yang diatur.
- MEWAJIBKAN        : Pasal/Regulasi -> Kewajiban.
- BERLAKU_UNTUK     : Kewajiban/Sanksi/Regulasi -> Lembaga yang dikenai. ("menyusun kebijakan perkreditan" BERLAKU_UNTUK "Bank")
- MENGENAKAN_SANKSI : Pasal/Lembaga -> Sanksi. ("POJK 42/2017 Pasal 7" MENGENAKAN_SANKSI "teguran tertulis")
- MENDEFINISIKAN    : Pasal -> Istilah yang didefinisikan.
- MERUJUK           : Pasal/Regulasi -> Pasal/Regulasi lain yang dirujuk ("sebagaimana dimaksud dalam ...", "berdasarkan ...").
- MENYAMPAIKAN      : Lembaga -> Dokumen yang wajib disampaikan/disusun. Hanya untuk penyampaian dokumen.
- MENCABUT          : Regulasi -> Regulasi yang dicabut/dinyatakan tidak berlaku.

CONTOH (teks: "Pasal 7 (1) Bank yang tidak memenuhi kewajiban sebagaimana dimaksud dalam Pasal 2 dikenai sanksi teguran tertulis." Sumber dokumen: POJK 42 Tahun 2017):
- "POJK 42/2017 Pasal 7" BAGIAN_DARI "POJK 42/2017"
- "POJK 42/2017 Pasal 7" MERUJUK "POJK 42/2017 Pasal 2"
- "POJK 42/2017 Pasal 7" MENGENAKAN_SANKSI "teguran tertulis"
- "teguran tertulis" BERLAKU_UNTUK "Bank"

ATURAN UMUM:
- Hanya gunakan tipe node dan tipe relationship di atas, sesuai artinya. Jangan memakai satu tipe relationship untuk semuanya.
- Abaikan bagian administratif (penetapan, pengundangan, Lembaran Negara, tanda tangan pejabat).
- Lebih baik sedikit hubungan yang benar daripada banyak hubungan yang salah.

Jawab hanya dalam format terstruktur yang diminta, tanpa penjelasan.`;

export const EXTRACTION_PROMPT = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM],
  ['human', 'Ekstrak knowledge graph dari teks berikut:\n\n{input}'],
]);

/** "POJK 12 Tahun 2021 TENTANG BANK UMUM.pdf" -> passed to the LLM as context for qualifying Pasal ids. */
export function extractionInput(filename: string, text: string): string {
  return `Sumber dokumen: ${filename.replace(/\.pdf$/i, '')}\n\n${text}`;
}

/** Collapse whitespace so "Bank  Umum " and "Bank Umum" become the same node. */
export function normalizeId(id: string | number): string {
  return String(id).replace(/\s+/g, ' ').trim();
}

/** "POJK 42 Tahun 2017 TENTANG ....pdf" -> "POJK 42/2017" (undefined if the filename doesn't follow that pattern). */
export function regulationFromFilename(filename: string): string | undefined {
  const m = filename.match(/POJK\s+(?:Nomor\s+)?(\d+)\s+Tahun\s+(\d{4})/i);
  return m ? `POJK ${m[1]}/${m[2]}` : undefined;
}

/**
 * The model sometimes writes a bare "Pasal 7". Every regulation has a Pasal 7,
 * so qualify it with the chunk's own regulation to keep them as separate nodes.
 */
export function qualifyPasal(id: string, regulation: string | undefined): string {
  return regulation && /^Pasal\s+\d+[A-Z]?$/i.test(id) ? `${regulation} ${id}` : id;
}

/** Case-insensitive key used to merge "Teguran Tertulis" with "teguran tertulis". */
export const entityKey = (id: string) => id.toLowerCase();
