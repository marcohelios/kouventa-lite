import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { PrismaClient } from './prisma/generated/client/client'; // Adjust path if needed
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config'; // Force dotenv to load your DATABASE_URL
import { Ollama } from 'ollama';
import { PDFParse } from 'pdf-parse';

// 1. Explicitly create the Postgres connection pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 2. Wrap the pool in the Prisma Adapter
const adapter = new PrismaPg(pool);

// 3. Initialize Prisma using the configured adapter
const prisma = new PrismaClient({ adapter });

// Initialize Fastify and plugins
const app = Fastify({ logger: true });

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST,
});

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

interface ChatBody {
  message: string;
  sessionId?: string;
  documentId?: string;
}

async function registerPlugins() {
  await app.register(cors, {});
  // @fastify/multipart replaces multer. Default limits are generous;
  // tighten fileSize if you want to cap upload size explicitly.
  await app.register(multipart);
}

// --- PDF UPLOAD ENDPOINT ---
app.post('/api/upload', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    // request.file() throws if the request body isn't multipart/form-data
    // at all (e.g. no file attached), rather than returning undefined.
    // Check isMultipart() first so that case cleanly returns 400 instead
    // of falling into the catch block below as a 500.
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const fileBuffer = await data.toBuffer();
    const filename = data.filename;

    const parser = new PDFParse({ data: fileBuffer });
    const result = await parser.getText();
    const rawText = result.text;

    // Split the text into overlapping chunks
    const chunks = chunkText(rawText);

    // Create the parent Document record in the database
    const document = await prisma.document.create({
      data: { filename: filename },
    });

    // Generate embeddings and save each chunk
    let chunksProcessed = 0;
    for (const chunk of chunks) {
      const embedResponse = await ollama.embeddings({
        model: 'nomic-embed-text',
        prompt: chunk,
      });

      const vectorString = `[${embedResponse.embedding.join(',')}]`;

      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" (
          "id", "documentId", "content", "embedding"
        ) VALUES (
          gen_random_uuid(),
          ${document.id},
          ${chunk},
          ${vectorString}::vector
        )
      `;
      chunksProcessed++;
    }

    return reply.status(200).send({
      success: true,
      message: `Successfully processed ${filename}`,
      chunksCreated: chunksProcessed,
    });
  } catch (error) {
    app.log.error(error, 'Error processing PDF');
    return reply.status(500).send({ error: 'Failed to process document' });
  }
});

// ==========================================
// 1. LIST UPLOADED DOCUMENTS
// ==========================================
app.get('/api/documents', async (request: FastifyRequest, reply: FastifyReply) => {
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

    return reply.status(200).send(formattedDocs);
  } catch (error) {
    app.log.error(error, 'Error fetching documents');
    return reply.status(500).send({ error: 'Failed to fetch documents' });
  }
});

// ==========================================
// 2. DOCUMENT RAG CHAT (STREAMING)
// ==========================================
app.post('/api/chat', async (request: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
  try {
    const { message, sessionId, documentId } = request.body;

    if (!message) {
      return reply.status(400).send({ error: 'Message is required' });
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
          LIMIT 5
        `
      : await prisma.$queryRaw<ChunkResult[]>`
          SELECT dc.id, dc."documentId", d.filename, dc.content
          FROM "DocumentChunk" dc
          JOIN "Document" d ON dc."documentId" = d.id
          ORDER BY dc.embedding <=> ${vectorString}::vector
          LIMIT 5
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

    const systemPrompt = `You are an internal knowledge assistant. Answer the user's question based on the retrieved sources.
If the source do not contain the answer, Tell me user that you do not have information about that topic. Do not speculate or hallucinate.

Document Context:
${contextString || 'No matching document context found.'}`;

    const messagesPayload = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: message },
    ];

    // 5. Take over the raw response for Server-Sent Events (SSE).
    // reply.hijack() tells Fastify "I'm handling this response myself" —
    // without it, Fastify will try to serialize/send its own response
    // on top of what we write manually below.
    reply.hijack();

    // Carry over headers Fastify has collected so far (this includes CORS)
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(key, value);
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send metadata (session ID and source document citations)
    const sources = relevantChunks.map((c) => ({
      documentId: c.documentId,
      filename: c.filename,
    }));

    reply.raw.write(
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
      reply.raw.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    // 7. Save conversation to database
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: currentSessionId, role: 'user', content: message },
        { sessionId: currentSessionId, role: 'assistant', content: fullAiResponse },
      ],
    });

    reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return reply.raw.end();
  } catch (error) {
    app.log.error(error, 'Error in RAG chat endpoint');
    if (!reply.raw.headersSent) {
      return reply.status(500).send({ error: 'Internal server error' });
    }
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', content: 'Inference failed.' })}\n\n`);
    return reply.raw.end();
  }
});

app.delete('/api/documents/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  try {
    const documentId = request.params.id;

    // The 'onDelete: Cascade' in schema.prisma ensures all associated chunks are also deleted
    await prisma.document.delete({
      where: { id: documentId },
    });

    return reply.status(200).send({ success: true, message: 'Document and associated vectors deleted.' });
  } catch (error) {
    app.log.error(error, 'Error deleting document');
    return reply.status(500).send({ error: 'Failed to delete document' });
  }
});

// --- START SERVER ---
const startServer = async () => {
  try {
    await registerPlugins();
    // Fastify's listen() is a real Promise that resolves to the address
    // string — unlike Express's listen(), which returns the Server
    // instance and made the old log line print "[object Object]".
    const address = await app.listen({ port: 3001, host: '0.0.0.0' });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

startServer();