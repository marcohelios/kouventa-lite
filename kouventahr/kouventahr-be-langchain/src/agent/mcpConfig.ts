import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../config/config';

/** Settings every server type shares. Tool filters match the server's original (unprefixed) tool names. */
const common = {
  allowedTools: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
  /** Usage notes appended to the agent's system prompt while this server is loaded. */
  instructions: z.string().optional(),
  /** Tool results longer than this are truncated before they reach the model. */
  maxResultChars: z.number().int().positive().optional(),
  /** Per tool-call timeout; a timed-out call comes back to the agent as a tool error. */
  timeoutMs: z.number().int().positive().optional(),
};

const stdioServer = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  ...common,
});

const httpServer = z.object({
  url: z.url(),
  transport: z.enum(['http', 'sse']).default('http'),
  headers: z.record(z.string(), z.string()).optional(),
  ...common,
});

const serverSchema = z.union([stdioServer, httpServer]);

const fileSchema = z.object({
  /** Replaces the default agent system prompt. */
  instructions: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

export type McpServerConfig = z.infer<typeof serverSchema>;
export interface McpConfig {
  instructions?: string;
  mcpServers: Record<string, McpServerConfig>;
}

/** Extra `${VAR}` values for one load of mcp.json (the tenant's Neo4j connection); they win over process.env. */
export type McpVars = Record<string, string>;

/** Replaces `${VAR}` in every string of a parsed JSON value. Throws if a variable is unset or empty. */
function interpolate(value: unknown, vars: McpVars): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = vars[name] ?? process.env[name];
      if (!resolved) throw new Error(`environment variable ${name} is not set`);
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

/**
 * Reads mcp.json. A missing file means "no MCP servers"; unparsable JSON is a startup error.
 * Each server is resolved and validated on its own, so one with a missing env var or a bad
 * shape is skipped with a warning instead of taking the others down. (Error messages never
 * include resolved values, since those can be credentials.)
 */
export async function loadMcpConfig(vars: McpVars = {}): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await readFile(config.mcpConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[agent] No MCP config at ${config.mcpConfigPath}; running with built-in tools only.`);
      return { mcpServers: {} };
    }
    throw err;
  }

  const file = fileSchema.parse(JSON.parse(raw));
  const mcpServers: Record<string, McpServerConfig> = {};

  for (const [name, entry] of Object.entries(file.mcpServers)) {
    try {
      mcpServers[name] = serverSchema.parse(interpolate(entry, vars));
    } catch (err) {
      const reason =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          : (err as Error).message;
      console.warn(`[agent] MCP server "${name}" skipped: ${reason}`);
    }
  }
  return { instructions: file.instructions, mcpServers };
}
