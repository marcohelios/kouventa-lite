import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from './prisma/generated/client/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import ollama from 'ollama';

// ==========================================
// 1. DATABASE & SERVER INITIALIZATION
// ==========================================
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const fastify = Fastify({ logger: true });

fastify.register(cors, {
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
});

// Helper Interface for Raw Queries
interface ProductResult {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
}

// ==========================================
// 2. GET: FETCH ALL PRODUCTS
// ==========================================
fastify.get('/api/products', async (request, reply) => {
  try {
    const products = await prisma.product.findMany({
      select: { id: true, name: true, description: true, price: true, category: true },
      orderBy: { name: 'asc' },
    });
    return products;
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Failed to fetch products' });
  }
});

// ==========================================
// 3. POST: ADD PRODUCT & GENERATE VECTOR
// ==========================================
fastify.post('/api/products', async (request, reply) => {
  try {
    const { name, description, price, category } = request.body as any;

    // 1. Generate Vector with Ollama
    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: description,
    });
    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    // 2. Insert into PostgreSQL using pgvector format
  await prisma.$executeRaw`
    INSERT INTO "Product" (
      "id", "name", "description", "price", "category", "embedding", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), 
      ${name}, 
      ${description}, 
      ${price}, 
      ${category}, 
      ${vectorString}::vector, 
      NOW(), 
      NOW()
    )
  `;

    return { success: true, message: `Successfully processed ${name}` };
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Failed to add product' });
  }
});

// ==========================================
// 4. DELETE: REMOVE PRODUCT BY ID
// ==========================================
fastify.delete('/api/products/:id', async (request, reply) => {
  try {
    const { id } = request.params as { id: string };
    
    await prisma.product.delete({
      where: { id: id },
    });
    
    return { success: true, message: `Deleted product ID: ${id}` };
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Failed to delete product' });
  }
});

// ==========================================
// 5. POST: SEMANTIC VECTOR SEARCH
// ==========================================
fastify.post('/api/search', async (request, reply) => {
  try {
    const { query } = request.body as { query: string };

    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: query,
    });
    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    // Search using the <=> cosine distance operator
    const results = await prisma.$queryRaw<ProductResult[]>`
      SELECT id, name, description, price, category
      FROM "Product"
      ORDER BY embedding <=> ${vectorString}::vector
      LIMIT 10
    `;

    return { success: true, results };
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Failed to execute vector search' });
  }
});

// ==========================================
// 6. POST: RAG CHAT (STREAMING VIA SSE)
// ==========================================
fastify.post('/api/chat', async (request, reply) => {
  try {
    const { message } = request.body as { message: string };

    if (!message) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    // 1. Embed user query
    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: message,
    });
    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    // 2. Fetch context from DB
    const relevantProducts = await prisma.$queryRaw<ProductResult[]>`
      SELECT id, name, description, price, category
      FROM "Product"
      ORDER BY embedding <=> ${vectorString}::vector
    `;

    // 3. Build Context String
    const contextString = relevantProducts
      .map((p, i) => `[Product ${i + 1}]: ${p.name}\nPrice: $${p.price}\nDescription: ${p.description}`)
      .join('\n\n');

    const systemPrompt = `You are a helpful e-commerce assistant. Answer the user's question based strictly on the provided product context. 
If the information is not in the context, state that you do not have that information. Do not hallucinate.

Context:
${contextString || 'No matching products found.'}`;

    // 4. Set headers for SSE on Fastify's raw response object
    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Transfer-Encoding', 'chunked');

    // 5. Stream from Ollama
    const stream = await ollama.chat({
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.message.content;
      reply.raw.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    reply.raw.end();
    
    // Tell Fastify that we handled the response natively
    return reply;

  } catch (error) {
    request.log.error(error);
    if (!reply.raw.headersSent) {
      return reply.status(500).send({ error: 'Failed to generate chat response' });
    }
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', content: 'Inference failed.' })}\n\n`);
    reply.raw.end();
  }
});

// ==========================================
// 7. START SERVER ON PORT 3002
// ==========================================
const start = async () => {
  try {
    await fastify.listen({ port: 3002 });
    console.log('Fastify Fallback Backend running on http://localhost:3002');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();