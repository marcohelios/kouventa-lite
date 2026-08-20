import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { PrismaClient } from './prisma/generated/client/client'; // Adjust path if needed
import { PrismaPg } from '@prisma/adapter-pg';
import ollama from 'ollama';

// Initialize Prisma 7 with the PostgreSQL adapter
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

const app = express();
app.use(cors());
app.use(express.json());

// Type definition for the raw SQL result
interface ProductResult {
  id: string;
  name: string;
  description: string;
  price: number;
}

app.get('/', (req: Request, res: Response) => {
  res.send('Kouventa Lite Backend is running! Send a POST request to /api/chat to talk to the AI.');
});

app.post('/api/chat', async (req: Request, res: Response): Promise<any> => {
  try {
    const { message, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // 1. Embed and Search (Same as before)
    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: message,
    });
    
    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    const relevantProducts = await prisma.$queryRaw<ProductResult[]>`
      SELECT id, name, description, price
      FROM "Product"
      ORDER BY embedding <=> ${vectorString}::vector
      LIMIT 3;
    `;

    // 2. Manage Memory (Same as before)
    let currentSessionId = sessionId;
    let chatHistory: any[] = [];

    if (currentSessionId) {
      const session = await prisma.chatSession.findUnique({
        where: { id: currentSessionId },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 6 } },
      });

      if (session) {
        chatHistory = session.messages.map(msg => ({
          role: msg.role === 'AI' ? 'assistant' : msg.role.toLowerCase(),
          content: msg.content,
        }));
      }
    } else {
      const newSession = await prisma.chatSession.create({ data: {} });
      currentSessionId = newSession.id;
    }

    // 3. Construct the Prompt
    const contextString = relevantProducts
      .map(p => `- ${p.name}: ${p.description} ($${p.price})`)
      .join('\n');

    const messages = [
      {
        role: 'system',
        content: `You are a helpful customer support assistant for an e-commerce store. 
Use the following product information to answer the user's question. If the answer is not in the context, politely say you don't know.
Do not make up prices or products.

Available Products:
${contextString}`,
      },
      ...chatHistory,
      { role: 'user', content: message }
    ];

    // ==========================================
    // 4. NEW: SET UP SERVER-SENT EVENTS (SSE)
    // ==========================================
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Immediately send the session ID to the frontend
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: currentSessionId })}\n\n`);

    // 5. Generate Stream with Ollama
    const chatStream = await ollama.chat({
      model: 'llama3.1:8b',
      messages: messages,
      stream: true, // Enable streaming
    });

    let fullAiMessage = '';

    // Iterate through the stream as tokens arrive from your GPU
    for await (const chunk of chatStream) {
      const text = chunk.message.content;
      fullAiMessage += text;
      // Push each tiny chunk of text to the frontend immediately
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }

    // 6. Save the full completed message to the database
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: currentSessionId, role: 'USER', content: message },
        { sessionId: currentSessionId, role: 'AI', content: fullAiMessage },
      ],
    });

    // 7. Signal the frontend that the stream is finished
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();

  } catch (error) {
    console.error('Error in chat endpoint:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'Server error occurred.' })}\n\n`);
      return res.end();
    }
  }
});

app.get('/api/products', async (req: Request, res: Response): Promise<any> => {
  try {
    // Fetch all products, ordered by newest first
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      // Explicitly select standard columns to avoid querying the heavy vector array
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        category: true,
        inStock: true,
        createdAt: true,
      },
    });

    return res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req: Request, res: Response): Promise<any> => {
  try {
    const { name, description, price, category } = req.body;

    if (!name || !description || !price) {
      return res.status(400).json({ error: 'Name, description, and price are required' });
    }

    // 1. Combine the text for the AI context
    const textToEmbed = `${name} - ${description} - $${price}`;

    // 2. Generate the vector embedding using Ollama
    const embedResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: textToEmbed,
    });
    
    const vectorString = `[${embedResponse.embedding.join(',')}]`;

    // 3. Save to PostgreSQL using raw SQL (required for pgvector casting)
    await prisma.$executeRaw`
      INSERT INTO "Product" (
        "id", "name", "description", "price", "category", "inStock", "embedding", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), 
        ${name}, 
        ${description}, 
        ${parseFloat(price)}, 
        ${category || 'General'}, 
        true, 
        ${vectorString}::vector, 
        NOW(), 
        NOW()
      )
    `;

    return res.status(200).json({ success: true, message: 'Product added and embedded successfully!' });

  } catch (error) {
    console.error('Error adding product:', error);
    return res.status(500).json({ error: 'Failed to add product' });
  }
});

app.delete('/api/products/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const productId = req.params.id as string;

    await prisma.product.delete({
      where: { id: productId },
    });

    return res.status(200).json({ success: true, message: 'Product and its vector deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    return res.status(500).json({ error: 'Failed to delete product' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});