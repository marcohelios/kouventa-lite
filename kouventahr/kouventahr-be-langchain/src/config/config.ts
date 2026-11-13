import 'dotenv/config';

const int = (name: string, fallback: number): number => {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
};

export const config = {
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
  // `||`, not `??`: docker-compose passes unset variables through as "" and that must fall back too.
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || process.env.OPENAI_API_VERSION,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
  openaiChatModel: process.env.OPENAI_CHAT_MODEL,
  openaiApiVersion: process.env.OPENAI_API_VERSION,
  openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1',
  databaseUrl: process.env.DATABASE_URL,
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  chatModel: process.env.CHAT_MODEL ?? 'llama3.1:8b',
  retrieverK: int('RETRIEVER_K', 5),
  graphTimeoutMs: int('GRAPH_TIMEOUT_MS', 8000),
  // Source chunks pulled in via the graph (entity <-MENTIONS- chunk), on top of the vector top-k. 0 disables.
  graphChunkK: int('GRAPH_CHUNK_K', 3),
  graphEntityTypes: process.env.GRAPH_ENTITY_TYPES ?? 'Regulation, Organization, Obligation, Process',
  graphBuildConcurrency: int('GRAPH_BUILD_CONCURRENCY', 3),
  // Prefilled type hints for the "Graph" UI (same as the original CLI build).
  graphDefaultNodeTypes: ['Regulation', 'Organization', 'Obligation', 'Process'],
  graphDefaultRelTypes: ['REGULATES', 'BASED_ON', 'OBLIGATES'],
  // Agent (deepagents + MCP)
  mcpConfigPath: process.env.MCP_CONFIG_PATH || './mcp.json',
  agentSystemPromptFile: process.env.AGENT_SYSTEM_PROMPT_FILE || undefined,
  agentRecursionLimit: int('AGENT_RECURSION_LIMIT', 50),
  chunkSize: int('CHUNK_SIZE', 2000),
  chunkOverlap: int('CHUNK_OVERLAP', 200),
  port: int('PORT', 3001),
};
