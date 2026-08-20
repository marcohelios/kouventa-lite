import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { PrismaClient } from './prisma/generated/client/client'; // Adjust path if needed
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config'; // Force dotenv to load your DATABASE_URL
import ollama from 'ollama';
import { PDFParse } from 'pdf-parse';

// 1. Explicitly create the Postgres connection pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 2. Wrap the pool in the Prisma Adapter
const adapter = new PrismaPg(pool);

// 3. Initialize Prisma using the configured adapter
const prisma = new PrismaClient({ adapter });

// Initialize Express and Middleware
const app = express();
app.use(cors());
app.use(express.json());

// --- HELPER FUNCTION ---
// Splits text into chunks of ~500 words with a 50-word overlap
function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += (chunkSize - overlap)) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

interface ChunkResult {
  id: string;
  documentId: string;
  filename: string;
  content: string;
}

// --- PDF UPLOAD ENDPOINT ---
// Configure multer to hold the uploaded file in RAM
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('file'), async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const filename = req.file.originalname;

    const parser = new PDFParse({ data: fileBuffer });
    const result = await parser.getText();
    const rawText = result.text;

    // 2. Split the text into overlapping chunks
    const chunks = chunkText(rawText);

    // 3. Create the parent Document record in the database
    const document = await prisma.document.create({
      data: { filename: filename }
    });

    // 4. Generate embeddings and save each chunk
    let chunksProcessed = 0;
    for (const chunkText of chunks) {
      const embedResponse = await ollama.embeddings({
        model: 'nomic-embed-text',
        prompt: chunkText,
      });
      
      const vectorString = `[${embedResponse.embedding.join(',')}]`;

      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" (
          "id", "documentId", "content", "embedding"
        ) VALUES (
          gen_random_uuid(), 
          ${document.id}, 
          ${chunkText}, 
          ${vectorString}::vector
        )
      `;
      chunksProcessed++;
    }

    return res.status(200).json({ 
      success: true, 
      message: `Successfully processed ${filename}`,
      chunksCreated: chunksProcessed
    });

  } catch (error) {
    console.error('Error processing PDF:', error);
    return res.status(500).json({ error: 'Failed to process document' });
  }
});

// ==========================================
// 1. LIST UPLOADED DOCUMENTS
// ==========================================
app.get('/api/documents', async (req: Request, res: Response): Promise<any> => {
  try {
    const documents = await prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { chunks: true },
        },
      },
    });

    const formattedDocs = documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      chunkCount: doc._count.chunks,
      createdAt: doc.createdAt,
    }));

    return res.status(200).json(formattedDocs);
  } catch (error) {
    console.error('Error fetching documents:', error);
    return res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ==========================================
// 2. DOCUMENT RAG CHAT (STREAMING)
// ==========================================
app.post('/api/chat', async (req: Request, res: Response): Promise<any> => {
  try {
    const { message, sessionId, documentId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // 1. Generate embedding for user question
    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: message,
    });

    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    // 2. Vector search against DocumentChunk (optionally filter by documentId)
    const relevantChunks = documentId
      ? await prisma.$queryRaw<ChunkResult[]>`
          SELECT dc.id, dc."documentId", d.filename, dc.content
          FROM "DocumentChunk" dc
          JOIN "Document" d ON dc."documentId" = d.id
          WHERE dc."documentId" = ${documentId}
          ORDER BY dc.embedding <=> ${vectorString}::vector
          LIMIT 4;
        `
      : await prisma.$queryRaw<ChunkResult[]>`
          SELECT dc.id, dc."documentId", d.filename, dc.content
          FROM "DocumentChunk" dc
          JOIN "Document" d ON dc."documentId" = d.id
          ORDER BY dc.embedding <=> ${vectorString}::vector
          LIMIT 4;
        `;

    // 3. Manage Chat Session & History
    let currentSessionId = sessionId;
    let chatHistory: any[] = [];

    if (currentSessionId) {
      const session = await prisma.chatSession.findUnique({
        where: { id: currentSessionId },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 6 } },
      });

      if (session) {
        chatHistory = session.messages.map((msg) => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        }));
      }
    } else {
      const newSession = await prisma.chatSession.create({ data: {} });
      currentSessionId = newSession.id;
    }

    // 4. Construct Context Prompt
    const contextString = relevantChunks
      .map((c, i) => `[Excerpt ${i + 1} from "${c.filename}"]:\n${c.content}`)
      .join('\n\n---\n\n');

    const systemPrompt = `You are an internal knowledge assistant. Answer the user's question based strictly on the provided document source.
If the source do not contain the answer, explicitly state that the information is not present in the uploaded documents. Do not speculate or hallucinate.

Document Context:
${contextString || 'No matching document context found.'}`;

    const messagesPayload = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: message },
    ];

    // 5. Initialize Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send metadata (session ID and source document citations)
    const sources = relevantChunks.map((c) => ({
      documentId: c.documentId,
      filename: c.filename,
    }));

    res.write(
      `data: ${JSON.stringify({
        type: 'meta',
        sessionId: currentSessionId,
        sources: sources,
      })}\n\n`
    );

    // 6. Stream Response from Ollama
    const stream = await ollama.chat({
      model: 'llama3.1:8b',
      messages: messagesPayload,
      stream: true,
    });

    let fullAiResponse = '';
    for await (const chunk of stream) {
      const text = chunk.message.content;
      fullAiResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    // 7. Save conversation to database
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: currentSessionId, role: 'user', content: message },
        { sessionId: currentSessionId, role: 'assistant', content: fullAiResponse },
      ],
    });

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();
  } catch (error) {
    console.error('Error in RAG chat endpoint:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Inference failed.' })}\n\n`);
    return res.end();
  }
});

app.delete('/api/documents/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const documentId = req.params.id as string;

    // The 'onDelete: Cascade' in schema.prisma ensures all associated chunks are also deleted
    await prisma.document.delete({
      where: { id: documentId },
    });

    return res.status(200).json({ success: true, message: 'Document and associated vectors deleted.' });
  } catch (error) {
    console.error('Error deleting document:', error);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
});

// --- START SERVER ---
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Kouventa Workspace Backend running on http://localhost:${PORT}`);
});