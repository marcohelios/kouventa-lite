import 'dotenv/config';

const int = (name: string, fallback: number): number => {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
};

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  chatModel: process.env.CHAT_MODEL ?? 'llama3.1:8b',
  retrieverK: int('RETRIEVER_K', 5),
  chunkSize: int('CHUNK_SIZE', 2000),
  chunkOverlap: int('CHUNK_OVERLAP', 200),
  port: int('PORT', 3001),

  // GraphRAG (comparison only, see src/graphrag/)
  neo4jUrl: process.env.NEO4J_URL ?? 'bolt://localhost:7687',
  neo4jUser: process.env.NEO4J_USER ?? 'neo4j',
  neo4jPassword: process.env.NEO4J_PASSWORD ?? 'password123',
  graphExtractModel: process.env.GRAPH_EXTRACT_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.1:8b',
  graphSeedEntities: int('GRAPH_SEED_ENTITIES', 10),
  graphMaxNeighbors: int('GRAPH_MAX_NEIGHBORS', 10),
};
