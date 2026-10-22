import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config';
import * as db from './db';
import { initVectorStore, getRetriever, deleteChunks } from './vectorstore';
import { splitPdf, ingest, formatContext, chain } from './rag';

const app = Fastify({ logger: true });

interface ChatBody {
  message: string;
  sessionId?: string;
  documentId?: string;
}

// --- PDF UPLOAD ENDPOINT ---
app.post('/api/upload', async (request: FastifyRequest, reply: FastifyReply) => {
  let documentId: string | undefined;
  try {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const fileBuffer = await data.toBuffer();
    const filename = data.filename;

    const chunks = await splitPdf(fileBuffer);

    documentId = await db.createDocument(filename);
    const chunksCreated = await ingest(documentId, filename, chunks);
    await db.setChunkCount(documentId, chunksCreated);

    return reply.status(200).send({
      success: true,
      message: `Successfully processed ${filename}`,
      chunksCreated,
      documentId,
    });
  } catch (error) {
    app.log.error(error, 'Error processing PDF');
    // Roll back a half-ingested document so it doesn't show up in the list.
    if (documentId) {
      try {
        await deleteChunks(documentId);
        await db.deleteDocument(documentId);
      } catch (cleanupError) {
        app.log.error(cleanupError, 'Rollback after failed upload also failed');
      }
    }
    return reply.status(500).send({ error: 'Failed to process document' });
  }
});

// --- LIST UPLOADED DOCUMENTS ---
app.get('/api/documents', async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.status(200).send(await db.listDocuments());
  } catch (error) {
    app.log.error(error, 'Error fetching documents');
    return reply.status(500).send({ error: 'Failed to fetch documents' });
  }
});

// --- DOCUMENT RAG CHAT (STREAMING) ---
app.post('/api/chat', async (request: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
  try {
    const { message, sessionId, documentId } = request.body ?? ({} as ChatBody);

    if (!message) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    // 1. Retrieve: standard LangChain vector-store retriever (top-k similarity)
    const retriever = getRetriever(documentId);
    const relevantDocs = await retriever.invoke(message);

    // 2. Chat session & history
    let currentSessionId = sessionId;
    let history: db.HistoryMessage[] = [];

    if (!currentSessionId || !(await db.sessionExists(currentSessionId))) {
      currentSessionId = await db.createSession();
    } else {
      history = await db.getHistory(currentSessionId, 6);
    }

    // 3. Take over the raw response for Server-Sent Events
    reply.hijack();

    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(key, value);
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sources = relevantDocs.map((d) => ({
      documentId: d.metadata.documentId,
      filename: d.metadata.filename,
    }));

    reply.raw.write(
      `data: ${JSON.stringify({ type: 'meta', sessionId: currentSessionId, sources })}\n\n`
    );

    // 4. Generate: stream tokens from the local LLM
    const stream = await chain.stream({
      context: formatContext(relevantDocs) || 'No matching document context found.',
      history: history.map((m) => [m.role, m.content] as [string, string]),
      question: message,
    });

    let fullAiResponse = '';
    for await (const text of stream) {
      fullAiResponse += text;
      reply.raw.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    // 5. Persist the exchange
    await db.saveMessages(currentSessionId, message, fullAiResponse);

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

// --- DELETE DOCUMENT (+ its vectors) ---
app.delete('/api/documents/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  try {
    const id = request.params.id;

    if (!db.isUuid(id) || (await db.deleteDocument(id)) === 0) {
      return reply.status(404).send({ error: 'Document not found' });
    }
    await deleteChunks(id);

    return reply.status(200).send({ success: true, message: 'Document and associated vectors deleted.' });
  } catch (error) {
    app.log.error(error, 'Error deleting document');
    return reply.status(500).send({ error: 'Failed to delete document' });
  }
});

// --- START SERVER ---
const startServer = async () => {
  try {
    await app.register(cors, {});
    await app.register(multipart);
    await initVectorStore();
    const address = await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

startServer();
