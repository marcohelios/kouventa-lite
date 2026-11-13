import { FastifyInstance, FastifyReply } from 'fastify';
import { config } from './config/config';
import * as db from './db';
import { getGraph } from './graph/neo4j';
import { sanitizeNodeTypes, sanitizeRelTypes } from './graph/transformer';
import { cancelJob, getJob, getJobForDocument, startBuild } from './graph/buildJob';
import { HttpError } from './graph/httpError';
import * as store from './graph/store';
import { createType, deleteType, listTypes, renameType, resolveType } from './graph/types';

/** Entity names are free text; keep them printable and bounded. */
function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/\s+/g, ' ');
  return s && s.length <= 300 ? s : undefined;
}

function oneType(v: unknown, sanitize: (l: string[]) => string[]): string | undefined {
  return typeof v === 'string' ? sanitize([v])[0] : undefined;
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function graphRoutes(app: FastifyInstance) {
  const bad = (reply: FastifyReply, error: string) => reply.status(400).send({ error });
  const notFound = (reply: FastifyReply, what = 'Not found in this document\'s graph') =>
    reply.status(404).send({ error: what });

  /** Resolves :docId to an existing document, or answers 404. */
  async function requireDoc(tenantId: string, docId: string, reply: FastifyReply) {
    const doc = await db.getDocument(tenantId, docId);
    if (!doc) {
      notFound(reply, 'Document not found');
      return undefined;
    }
    return doc;
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    request.log.error(error, 'Graph route error');
    return reply.status(500).send({ error: 'Graph operation failed' });
  });

  // Create-graph hints: the document's saved node types (starter + custom) and the configured relationship types.
  app.get<{ Params: { docId: string } }>('/api/graph/documents/:docId/defaults', async (request, reply) => {
    const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
    if (!doc) return;
    return {
      nodeTypes: await db.listSavedNodeTypes(request.tenant.id, doc.id),
      relTypes: config.graphDefaultRelTypes,
    };
  });

  // -------------------------------------------------------------- types ----
  // Node types belong to one document's graph.
  app.get<{ Params: { docId: string } }>('/api/graph/documents/:docId/types', async (request, reply) => {
    const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
    if (!doc) return;
    return { types: await listTypes(request.tenant, await getGraph(request.tenant), doc.id) };
  });

  app.post<{ Params: { docId: string }; Body: { name?: string } }>(
    '/api/graph/documents/:docId/types',
    async (request, reply) => {
      const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
      if (!doc) return;
      const name = await createType(request.tenant, await getGraph(request.tenant), doc.id, request.body?.name);
      return reply.status(201).send({ name });
    }
  );

  app.patch<{ Params: { docId: string; name: string }; Body: { newName?: string } }>(
    '/api/graph/documents/:docId/types/:name',
    async (request, reply) => {
      const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
      if (!doc) return;
      return renameType(
        request.tenant,
        await getGraph(request.tenant),
        doc.id,
        request.params.name,
        request.body?.newName
      );
    }
  );

  app.delete<{ Params: { docId: string; name: string } }>(
    '/api/graph/documents/:docId/types/:name',
    async (request, reply) => {
      const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
      if (!doc) return;
      await deleteType(request.tenant, await getGraph(request.tenant), doc.id, request.params.name);
      return { success: true };
    }
  );

  // ------------------------------------------------------------- build ----
  app.post<{ Body: { documentId?: string; nodeTypes?: string[]; relTypes?: string[] } }>(
    '/api/graph/build',
    async (request, reply) => {
      const { documentId, nodeTypes, relTypes } = request.body ?? {};
      if (!documentId || !db.isUuid(documentId)) return bad(reply, 'documentId is required');

      const job = await startBuild(
        request.tenant,
        documentId,
        sanitizeNodeTypes(stringList(nodeTypes)),
        sanitizeRelTypes(stringList(relTypes))
      );
      return reply.status(202).send({ jobId: job.id });
    }
  );

  app.get<{ Params: { id: string } }>('/api/graph/jobs/:id', async (request, reply) => {
    return getJob(request.tenant.id, request.params.id) ?? notFound(reply, 'Job not found');
  });

  app.post<{ Params: { id: string } }>('/api/graph/jobs/:id/cancel', async (request, reply) => {
    return cancelJob(request.tenant.id, request.params.id)
      ? { success: true }
      : reply.status(409).send({ error: 'Job is not running' });
  });

  app.get<{ Params: { docId: string } }>('/api/graph/documents/:docId/job', async (request, reply) => {
    return getJobForDocument(request.tenant.id, request.params.docId) ?? notFound(reply, 'No job for this document');
  });

  // -------------------------------------------------------- read/delete ----
  app.get<{ Params: { docId: string } }>('/api/graph/documents/:docId', async (request, reply) => {
    if (!(await requireDoc(request.tenant.id, request.params.docId, reply))) return;
    return store.getDocumentGraph(await getGraph(request.tenant), request.params.docId);
  });

  app.delete<{ Params: { docId: string } }>('/api/graph/documents/:docId', async (request, reply) => {
    const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
    if (!doc) return;
    if (doc.graphStatus === 'building') {
      return reply.status(409).send({ error: 'Cancel the running build first' });
    }
    await store.removeDocumentGraph(await getGraph(request.tenant), doc.id);
    await db.setGraphStatus(request.tenant.id, doc.id, { status: 'none', chunksTotal: 0, chunksFailed: 0 });
    return { success: true };
  });

  // -------------------------------------------------------------- edges ----
  app.post<{
    Params: { docId: string };
    Body: { source?: string; target?: string; type?: string; sourceType?: string; targetType?: string };
  }>('/api/graph/documents/:docId/edges', async (request, reply) => {
    const doc = await requireDoc(request.tenant.id, request.params.docId, reply);
    if (!doc) return;
    const b = request.body ?? {};
    const source = cleanName(b.source);
    const target = cleanName(b.target);
    const type = oneType(b.type, sanitizeRelTypes);
    if (!source || !target || !type) return bad(reply, 'source, target and a valid relationship type are required');
    if (source === target) return bad(reply, 'source and target must be different');

    // Types can't be made on the fly: a brand-new endpoint needs a type picked from the available list.
    const graph = await getGraph(request.tenant);
    const known = await store.existingEntityIds(graph, doc.id, [source, target]);
    const typeFor = async (name: string, given: unknown) => {
      if (known.has(name)) return undefined; // existing node keeps its own type
      if (given === undefined || given === '') throw new HttpError(400, `Choose a type for the new node "${name}"`);
      return resolveType(request.tenant, graph, doc.id, given);
    };
    const key = await store.addEdge(graph, doc.id, {
      source,
      target,
      type,
      sourceType: await typeFor(source, b.sourceType),
      targetType: await typeFor(target, b.targetType),
    });
    return reply.status(201).send({ key });
  });

  app.patch<{
    Params: { docId: string; key: string };
    Body: { type?: string; reverse?: boolean };
  }>('/api/graph/documents/:docId/edges/:key', async (request, reply) => {
    if (!(await requireDoc(request.tenant.id, request.params.docId, reply))) return;
    const { type, reverse } = request.body ?? {};
    const cleanType = type === undefined ? undefined : oneType(type, sanitizeRelTypes);
    if (type !== undefined && !cleanType) return bad(reply, 'Invalid relationship type');
    if (!cleanType && !reverse) return bad(reply, 'Nothing to change');

    const key = await store.updateEdge(await getGraph(request.tenant), request.params.docId, request.params.key, {
      type: cleanType,
      reverse: !!reverse,
    });
    return key ? { key } : notFound(reply);
  });

  app.delete<{ Params: { docId: string; key: string } }>(
    '/api/graph/documents/:docId/edges/:key',
    async (request, reply) => {
      if (!(await requireDoc(request.tenant.id, request.params.docId, reply))) return;
      const ok = await store.deleteEdge(await getGraph(request.tenant), request.params.docId, request.params.key);
      return ok ? { success: true } : notFound(reply);
    }
  );

  // ------------------------------------------------------------- nodes ----
  // Entity names can contain "/" and other URL-hostile characters, so the node
  // id travels in the body (PATCH) or query string (DELETE), not the path.
  app.patch<{
    Params: { docId: string };
    Body: { id?: string; type?: string; newId?: string };
  }>('/api/graph/documents/:docId/nodes', async (request, reply) => {
    if (!(await requireDoc(request.tenant.id, request.params.docId, reply))) return;
    const b = request.body ?? {};
    const id = typeof b.id === 'string' ? b.id : undefined;
    if (!id) return bad(reply, 'id is required');

    const newId = b.newId === undefined ? undefined : cleanName(b.newId);
    if (b.newId !== undefined && !newId) return bad(reply, 'Invalid name');
    const type = b.type === undefined ? undefined : await resolveType(request.tenant, await getGraph(request.tenant), request.params.docId, b.type);
    if (!newId && !type) return bad(reply, 'Nothing to change');

    const result = await store.updateNode(await getGraph(request.tenant), request.params.docId, id, { type, newId });
    return result ?? notFound(reply);
  });

  app.delete<{ Params: { docId: string }; Querystring: { id?: string } }>(
    '/api/graph/documents/:docId/nodes',
    async (request, reply) => {
      if (!(await requireDoc(request.tenant.id, request.params.docId, reply))) return;
      const id = request.query.id;
      if (!id) return bad(reply, 'id is required');
      const ok = await store.deleteNode(await getGraph(request.tenant), request.params.docId, id);
      return ok ? { success: true } : notFound(reply);
    }
  );
}
