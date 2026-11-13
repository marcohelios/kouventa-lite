import type { FastifyReply } from 'fastify';

/** Takes over the raw response for Server-Sent Events, keeping headers (e.g. CORS) set by plugins. */
export function startSse(reply: FastifyReply): void {
  reply.hijack();
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(key, value);
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

export function sendSse(reply: FastifyReply, event: Record<string, unknown>): void {
  if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}
