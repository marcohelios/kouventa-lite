import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantByKey, type Tenant } from './tenants';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every /api route. */
    tenant: Tenant;
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1];
}

/** Every /api request must carry a valid tenant API key; the tenant it maps to is attached to the request. */
export function registerTenantAuth(app: FastifyInstance): void {
  app.decorateRequest('tenant', undefined as unknown as Tenant);
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS' || !request.url.startsWith('/api/')) return;
    const token = bearerToken(request);
    const tenant = token ? await resolveTenantByKey(token) : undefined;
    if (!tenant) return reply.status(401).send({ error: 'Missing or invalid API key' });
    request.tenant = tenant;
  });
}
