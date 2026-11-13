import { MultiServerMCPClient, type Connection } from '@langchain/mcp-adapters';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import type { McpConfig, McpServerConfig } from './mcpConfig';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULT_CHARS = 8_000;
/** A server that isn't reachable yet (still booting) is retried after each of these delays. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

/** MCP clients by tenant id, so one tenant's can be closed without touching the others. */
const clients = new Map<string, MultiServerMCPClient[]>();

export interface McpLoadResult {
  tools: StructuredToolInterface[];
  /** Usage notes of the servers that actually loaded, for the system prompt. */
  instructions: Array<{ server: string; text: string }>;
}

function toConnection(server: McpServerConfig): Connection {
  const defaultToolTimeout = server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if ('command' in server) {
    return {
      transport: 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      defaultToolTimeout,
    };
  }
  if (server.transport === 'sse') {
    return { transport: 'sse', url: server.url, headers: server.headers, defaultToolTimeout };
  }
  return { transport: 'http', url: server.url, headers: server.headers, defaultToolTimeout };
}

/** Applies a server's allowedTools / blockedTools, matched against the original (unprefixed) tool name. */
function isExposed(server: McpServerConfig, originalName: string): boolean {
  if (server.allowedTools && !server.allowedTools.includes(originalName)) return false;
  if (server.blockedTools?.includes(originalName)) return false;
  return true;
}

/** Caps tool output so a runaway query can't flood the model's context; the note tells it to narrow down. */
function capResult(result: unknown, maxChars: number): unknown {
  const note = (total: number) =>
    `\n[truncated: ${total} chars total — narrow the query: add LIMIT, return fewer properties]`;

  if (typeof result === 'string') {
    return result.length > maxChars ? result.slice(0, maxChars) + note(result.length) : result;
  }
  if (Array.isArray(result)) {
    // Content blocks: cap the combined text, leave non-text blocks (images, resources) untouched.
    let remaining = maxChars;
    let total = 0;
    let truncated = false;
    const blocks = result.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block;
      total += block.text.length;
      if (block.text.length <= remaining) {
        remaining -= block.text.length;
        return block;
      }
      truncated = true;
      const kept = block.text.slice(0, Math.max(remaining, 0));
      remaining = 0;
      return { ...block, text: kept };
    });
    return truncated ? [...blocks, { type: 'text', text: note(total).trimStart() }] : blocks;
  }
  return result;
}

function withResultCap(tool: StructuredToolInterface, maxChars: number): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema: tool.schema as never,
    func: async (input: unknown, _runManager, config) => {
      // Inside an agent run the config carries `toolCall`, which makes the inner tool wrap its output in a
      // ToolMessage. Drop it so we get the raw content to cap; this wrapper's own call builds the ToolMessage.
      const { toolCall: _toolCall, ...innerConfig } = (config ?? {}) as Record<string, unknown>;
      const result: any = await tool.invoke(input as never, innerConfig as never);
      // Defensive: if a ToolMessage still comes back, cap its content instead of passing it through whole.
      const raw = result && typeof result === 'object' && !Array.isArray(result) && 'content' in result ? result.content : result;
      return capResult(raw, maxChars) as never;
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function discover(tenantId: string, entries: Array<[string, McpServerConfig]>) {
  const client = new MultiServerMCPClient({
    servers: Object.fromEntries(entries.map(([name, server]) => [name, toConnection(server)])),
    prefixToolNameWithServerName: true,
    // An unreachable server is simply absent from the result, so we can retry it below.
    onConnectionError: 'ignore',
  });
  clients.set(tenantId, [...(clients.get(tenantId) ?? []), client]);
  return client.listToolsets();
}

/**
 * Connects to every server in mcp.json and returns their tools, named `<server>_<tool>`.
 * Servers that aren't reachable yet are retried with backoff; one that never comes up is
 * logged and skipped, so a bad entry never blocks startup.
 */
export async function loadMcpTools(tenantId: string, mcp: McpConfig): Promise<McpLoadResult> {
  const entries = Object.entries(mcp.mcpServers);
  const result: McpLoadResult = { tools: [], instructions: [] };
  if (entries.length === 0) return result;

  const toolsets: Record<string, StructuredToolInterface[]> = { ...(await discover(tenantId, entries)) };

  for (const delay of RETRY_DELAYS_MS) {
    const missing = entries.filter(([name]) => !toolsets[name]);
    if (missing.length === 0) break;
    console.warn(`[agent] MCP not reachable yet: ${missing.map(([n]) => n).join(', ')}; retrying in ${delay / 1000}s`);
    await sleep(delay);
    Object.assign(toolsets, await discover(tenantId, missing));
  }

  for (const [name, server] of entries) {
    const serverTools = toolsets[name];
    if (!serverTools) {
      console.warn(`[agent] MCP server "${name}" is unavailable; skipped.`);
      continue;
    }
    const prefix = `${name}_`;
    const kept = serverTools
      .filter((t) => isExposed(server, t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name))
      .map((t) => withResultCap(t, server.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS));

    console.log(
      `[agent] MCP server "${name}": ${kept.length}/${serverTools.length} tools exposed (${kept.map((t) => t.name).join(', ')})`
    );
    result.tools.push(...kept);
    if (server.instructions) result.instructions.push({ server: name, text: server.instructions });
  }
  return result;
}

/** Closes one tenant's MCP clients, or every tenant's when no id is given. */
export async function closeMcpClients(tenantId?: string): Promise<void> {
  const ids = tenantId ? [tenantId] : [...clients.keys()];
  const closing = ids.flatMap((id) => clients.get(id) ?? []);
  for (const id of ids) clients.delete(id);
  await Promise.allSettled(closing.map((c) => c.close()));
}
