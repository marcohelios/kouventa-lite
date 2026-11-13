import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config/config';
import * as db from './db';
import { initVectorStore, deleteChunks } from './vectorstore';
import { hybridRetrieve } from './hybridRetriever';
import { closeGraph, getGraph } from './graph/neo4j';
import { removeDocumentGraph } from './graph/store';
import { graphRoutes } from './graphRoutes';
import { splitPdf, ingest, chain } from './rag';
import { startSse } from './sse';
import { agentRoutes } from './agent/agentRoutes';
import { closeAgent, initAgent } from './agent/agent';
import { registerTenantAuth } from './tenant/auth';

const app = Fastify({ logger: true });
registerTenantAuth(app);
app.addHook('onClose', closeGraph);
app.addHook('onClose', closeAgent);

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

    documentId = await db.createDocument(request.tenant.id, filename);
    await db.seedNodeTypes(request.tenant.id, documentId); // starter types for this document's graph
    const chunksCreated = await ingest(request.tenant.id, documentId, filename, chunks);
    await db.setChunkCount(request.tenant.id, documentId, chunksCreated);

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
        await deleteChunks(request.tenant.id, documentId);
        await db.deleteDocument(request.tenant.id, documentId);
      } catch (cleanupError) {
        app.log.error(cleanupError, 'Rollback after failed upload also failed');
      }
    }
    return reply.status(500).send({ error: 'Failed to process document' });
  }
});

// --- LIST UPLOADED DOCUMENTS ---
app.get('/api/documents', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.status(200).send(await db.listDocuments(request.tenant.id));
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

    // 1. Retrieve: pgvector top-k chunks + knowledge-graph facts (graph is best-effort)
    const { docs: relevantDocs, context, graphUsed, graphFacts, graphChunks, duplicateChunks, vectorMs, graphMs } =
      await hybridRetrieve(request.tenant, message, documentId);
    request.log.info(
      {
        graphUsed,
        graphFacts: graphFacts.length,
        totalChunks: relevantDocs.length,
        graphChunks,
        duplicateChunks,
        vectorMs,
        graphMs,
      },
      'Hybrid retrieval'
    );
    if (graphFacts.length > 0) request.log.debug({ graphFacts }, 'Graph facts');

    // 2. Chat session & history
    let currentSessionId = sessionId;
    let history: db.HistoryMessage[] = [];

    if (!currentSessionId || !(await db.sessionExists(request.tenant.id, currentSessionId))) {
      currentSessionId = await db.createSession(request.tenant.id);
    } else {
      history = await db.getHistory(request.tenant.id, currentSessionId, 6);
    }

    // 3. Take over the raw response for Server-Sent Events
    startSse(reply);

    const sources = relevantDocs.map((d) => ({
      documentId: d.metadata.documentId,
      filename: d.metadata.filename,
    }));

    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'meta',
        sessionId: currentSessionId,
        sources,
        graph: { used: graphUsed, facts: graphFacts.length },
      })}\n\n`
    );

    // 4. Generate: stream tokens from the local LLM
    const stream = await chain.stream({
      context: context || 'No matching document context found.',
      history: history.map((m) => [m.role, m.content] as [string, string]),
      question: message,
    });

    let fullAiResponse = '';
    for await (const text of stream) {
      fullAiResponse += text;
      reply.raw.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    // 5. Persist the exchange
    await db.saveMessages(request.tenant.id, currentSessionId, message, fullAiResponse);

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

    if (!db.isUuid(id) || (await db.deleteDocument(request.tenant.id, id)) === 0) {
      return reply.status(404).send({ error: 'Document not found' });
    }
    await deleteChunks(request.tenant.id, id);
    // The graph is optional enrichment: a Neo4j outage must not block deleting a document.
    try {
      await removeDocumentGraph(await getGraph(request.tenant), id);
    } catch (graphError) {
      app.log.error(graphError, 'Could not remove the deleted document from the knowledge graph');
    }

    return reply.status(200).send({ success: true, message: 'Document, vectors and graph data deleted.' });
  } catch (error) {
    app.log.error(error, 'Error deleting document');
    return reply.status(500).send({ error: 'Failed to delete document' });
  }
});

// --- START SERVER ---
const startServer = async () => {
  try {
    // The default method list is GET/HEAD/POST only, which blocks the browser's PATCH/DELETE preflight.
    await app.register(cors, { methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });
    await app.register(multipart);
    await app.register(graphRoutes);
    await app.register(agentRoutes);
    await db.migrate();
    await initVectorStore();
    await initAgent();
    const address = await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

startServer();
