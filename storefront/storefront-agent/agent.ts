import { createDeepAgent } from "deepagents";
import { ChatOllama } from "@langchain/ollama";
import { searchProducts, createProduct, deleteProduct } from "./tools";

const model = new ChatOllama({ model: "llama3.1:8b", baseUrl: "http://localhost:11434" });

export const agent = createDeepAgent({
  model,
  tools: [searchProducts, createProduct, deleteProduct],
  systemPrompt:
    "You are a product catalog assistant for an e-commerce store. " +
    "Use search_products to find items, create_product to add new items, " +
    "and delete_product to remove items. Always confirm details with the " +
    "user before creating or deleting a product.",
});