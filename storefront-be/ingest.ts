import 'dotenv/config';
import { PrismaClient } from './prisma/generated/client/client'; // Import from the new output path
import { PrismaPg } from '@prisma/adapter-pg';
import ollama from 'ollama';

// Prisma 7 requires initializing the client with the specific database adapter
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

async function main() {
// 1. Define the mock product
  const product = {
    name: "Classic Red Sneakers",
    description: "Comfortable canvas sneakers perfect for casual wear. Features a durable rubber sole.",
    price: 49.99,
    category: "Footwear",
    inStock: true
  };

  console.log(`Generating embedding for: ${product.name}`);

  // 2. Combine the relevant fields so the AI "reads" the whole context
  const textToEmbed = `${product.name} - ${product.description} - $${product.price}`;
  
  // 3. Call your local Ollama embedding model
  const response = await ollama.embeddings({
    model: 'nomic-embed-text',
    prompt: textToEmbed,
  });

  // Extract the array of 768 numbers and format it as a SQL string
  const embedding = response.embedding; 
  const vectorString = `[${embedding.join(',')}]`;

  console.log("Saving to PostgreSQL...");

  // 4. Save to Database using a parameterized raw SQL query
  await prisma.$executeRaw`
    INSERT INTO "Product" (
      "id", "name", "description", "price", "category", "inStock", "embedding", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), 
      ${product.name}, 
      ${product.description}, 
      ${product.price}, 
      ${product.category}, 
      ${product.inStock}, 
      ${vectorString}::vector, 
      NOW(), 
      NOW()
    )
  `;

  console.log("Product successfully saved with local vector embeddings!");
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
