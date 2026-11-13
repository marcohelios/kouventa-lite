import { readFile } from 'node:fs/promises';
import { createDeepAgent } from 'deepagents';
import { todoListMiddleware } from 'langchain';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { config } from '../config/config';
import type { Tenant } from '../tenant/tenants';
import { agentModel } from './model';
import { buildBuiltinTools } from './builtinTools';
import { loadMcpConfig } from './mcpConfig';
import { closeMcpClients, loadMcpTools } from './mcpTools';

const DEFAULT_INSTRUCTIONS = `You are a helpful, general-purpose assistant with access to tools.

- For multi-step tasks, plan first with write_todos and work through the steps, updating the todos as you go.
- For questions about uploaded documents, call list_documents and search_documents, and name the source filenames in your answer.
- Use the other available tools whenever they help; never invent tool results.
- If a tool fails or is unavailable, say so plainly instead of guessing.
- Reply in the same language as the user's message.`;

async function resolveInstructions(configured?: string): Promise<string> {
  if (config.agentSystemPromptFile) return (await readFile(config.agentSystemPromptFile, 'utf8')).trim();
  return configured?.trim() || DEFAULT_INSTRUCTIONS;
}

let checkpointer: PostgresSaver | undefined;

type Agent = Awaited<ReturnType<typeof buildAgent>>;
// One agent per tenant: its Neo4j MCP tool points at that tenant's own container.
const agents = new Map<string, Promise<Agent>>();

async function buildAgent(tenant: Tenant, saver: PostgresSaver) {
  // The server, never the model, decides which Neo4j the tool reaches.
  const mcp = await loadMcpConfig({
    TENANT_NEO4J_URI: tenant.neo4j.uri,
    TENANT_NEO4J_BASIC_AUTH: Buffer.from(`${tenant.neo4j.user}:${tenant.neo4j.password}`).toString('base64'),
  });
  const { tools: mcpTools, instructions: toolNotes } = await loadMcpTools(tenant.id, mcp);
  const builtinTools = buildBuiltinTools(tenant);
  console.log(`[agent:${tenant.slug}] ${builtinTools.length} built-in and ${mcpTools.length} MCP tools loaded.`);

  // Usage notes only for servers that actually loaded, so the agent is never told about tools it lacks.
  const notes = toolNotes.map((n) => `\n\n## Tool notes: ${n.server}\n${n.text}`).join('');

  return createDeepAgent({
    model: agentModel,
    // deepagents only attaches the planner for some model profiles; add it so write_todos is always available.
    middleware: [todoListMiddleware()],
    tools: [...builtinTools, ...mcpTools],
    systemPrompt: (await resolveInstructions(mcp.instructions)) + notes,
    checkpointer: saver,
  });
}

/** Opens the Postgres-backed checkpointer shared by every tenant's agent. Agents are built lazily per tenant. */
export async function initAgent(): Promise<void> {
  checkpointer = PostgresSaver.fromConnString(config.databaseUrl!);
  await checkpointer.setup();
}

/** The tenant's agent, built on first use and cached. A failed build is not cached, so the next request retries. */
export function getAgent(tenant: Tenant): Promise<Agent> {
  if (!checkpointer) throw new Error('Agent is not initialised');
  let pending = agents.get(tenant.id);
  if (!pending) {
    pending = buildAgent(tenant, checkpointer).catch(async (err) => {
      agents.delete(tenant.id);
      await closeMcpClients(tenant.id);
      throw err;
    });
    agents.set(tenant.id, pending);
  }
  return pending;
}

/** Drops a tenant's cached agent and closes its MCP clients. */
export async function evictAgent(tenantId: string): Promise<void> {
  agents.delete(tenantId);
  await closeMcpClients(tenantId);
}

export async function closeAgent(): Promise<void> {
  agents.clear();
  await closeMcpClients();
  await checkpointer?.end();
}
