import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { pool } from "./db";
import { Ollama } from "ollama";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const ollamaClient = new Ollama({ host: OLLAMA_URL });

interface ProductResult {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
}

async function embed(text: string): Promise<number[]> {
  const res = await ollamaClient.embeddings({ model: "nomic-embed-text", prompt: text });
  return res.embedding;
}

export const searchProducts = tool(
  async ({ query }: { query: string }) => {
    const embedding = await embed(query);
    const vectorStr = `[${embedding.join(",")}]`;

    const { rows } = await pool.query<ProductResult>(
      `SELECT id, name, description, price, category
       FROM "Product"
       ORDER BY embedding <=> $1::vector
       LIMIT 5`,
      [vectorStr]
    );

    if (rows.length === 0) return "No matching products found.";
    return JSON.stringify(rows, null, 2);
  },
  {
    name: "search_products",
    description:
      "Search the product catalog by semantic meaning. Use this when the user " +
      "asks about products, wants recommendations, or asks what's available.",
    schema: z.object({
      query: z.string().describe("A natural-language description of what to search for."),
    }),
  }
);

export const createProduct = tool(
  async ({ name, description, price, category }: { name: string; description: string; price: number; category: string }) => {
    const embedText = `Product: ${name} | Category: ${category} | Details: ${description}`;
    const embedding = await embed(embedText);
    const vectorStr = `[${embedding.join(",")}]`;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "Product" (id, name, description, price, category, embedding, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::vector, NOW(), NOW())
       RETURNING id`,
      [name, description, price, category, vectorStr]
    );

    const created = rows[0];
    if (!created) {
      return `Failed to create product '${name}' — no row returned.`;
    }

    return `Created product '${name}' with id ${created.id}.`;
  },
  {
    name: "create_product",
    description: "Create a new product in the catalog, including generating its search embedding.",
    schema: z.object({
      name: z.string().describe("Product name."),
      description: z.string().describe("Product description."),
      price: z.number().describe("Product price as a number."),
      category: z.string().describe("Product category."),
    }),
  }
);

export const deleteProduct = tool(
  async ({ productId }: { productId: string }) => {
    const result = await pool.query(`DELETE FROM "Product" WHERE id = $1`, [productId]);

    if (result.rowCount === 0) return `No product found with id ${productId}.`;
    return `Deleted product ${productId}.`;
  },
  {
    name: "delete_product",
    description: "Delete a product from the catalog by its id.",
    schema: z.object({
      productId: z.string().describe("The UUID of the product to delete."),
    }),
  }
);