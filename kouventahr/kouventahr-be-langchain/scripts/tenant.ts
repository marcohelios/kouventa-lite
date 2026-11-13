/**
 * Tenant administration.
 *
 *   npm run tenant:add -- <slug> [--name "Display name"] [--uri bolt://tenant-<slug>-neo4j:7687]
 *                                [--user neo4j] [--password-env TENANT_<SLUG>_NEO4J_PASSWORD]
 *   npm run tenant:rotate-key -- <slug>
 *   npm run tenant:remove -- <slug> --yes
 *
 * Run inside the app container so the in-compose Neo4j hostname resolves:
 *   docker compose exec app npm run tenant:add -- acme
 *
 * The tenant's Neo4j container is a static service in docker-compose.yml; this script does not create it.
 */
import { pool } from "../src/db";
import { createGraph, ensureIndexes } from "../src/graph/neo4j";
import { generateApiKey, hashApiKey, toTenant } from "../src/tenant/tenants";

const SLUG_RE = /^[a-z][a-z0-9-]{0,30}$/;

interface Args {
  command: string | undefined;
  slug: string | undefined;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) positional.push(rest[i]);
    else if (rest[i] === "--yes") flags.set("yes", "true");
    else flags.set(rest[i].slice(2), rest[++i] ?? "");
  }
  return { command, slug: positional[0], flags };
}

/** TENANT_<SLUG>_NEO4J_PASSWORD, with dashes turned into underscores. */
const defaultPasswordEnv = (slug: string) => `TENANT_${slug.toUpperCase().replace(/-/g, "_")}_NEO4J_PASSWORD`;

async function add(slug: string, flags: Map<string, string>): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new Error("Slug must be 1-31 chars: lowercase letters, digits and dashes, starting with a letter");

  const row = {
    name: flags.get("name") || slug,
    uri: flags.get("uri") || `bolt://tenant-${slug}-neo4j:7687`,
    user: flags.get("user") || "neo4j",
    passwordEnv: flags.get("password-env") || defaultPasswordEnv(slug),
  };
  const apiKey = generateApiKey();
  const candidate = toTenant({
    id: "pending",
    slug,
    neo4j_uri: row.uri,
    neo4j_user: row.user,
    neo4j_password_env: row.passwordEnv,
  });

  // Fail fast: prove the container is reachable with this password and set up its indexes before registering.
  console.log(`Connecting to ${row.uri} ...`);
  const graph = await createGraph(candidate.neo4j);
  try {
    await ensureIndexes(graph);
  } finally {
    await graph.close();
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, api_key_hash, neo4j_uri, neo4j_user, neo4j_password_env)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [slug, row.name, hashApiKey(apiKey), row.uri, row.user, row.passwordEnv]
  );

  console.log(`\nTenant "${slug}" created (id ${rows[0].id}).`);
  console.log(`API key (shown once, store it now):\n\n  ${apiKey}\n`);
}

async function rotateKey(slug: string): Promise<void> {
  const apiKey = generateApiKey();
  const res = await pool.query(`UPDATE tenants SET api_key_hash = $2 WHERE slug = $1`, [slug, hashApiKey(apiKey)]);
  if (!res.rowCount) throw new Error(`Unknown tenant "${slug}"`);
  console.log(`New API key for "${slug}" (the old one stopped working):\n\n  ${apiKey}\n`);
  console.log("Cached keys are not held in memory, so no restart is needed.");
}

async function remove(slug: string, flags: Map<string, string>): Promise<void> {
  if (!flags.has("yes")) throw new Error(`This deletes all Postgres data of "${slug}". Re-run with --yes to confirm.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!found.rowCount) throw new Error(`Unknown tenant "${slug}"`);
    const tenantId = found.rows[0].id;

    // Agent checkpoints are keyed by the chat session id, so collect those before the sessions cascade away.
    const sessions = (
      await client.query<{ id: string }>(`SELECT id::text AS id FROM chat_sessions WHERE tenant_id = $1`, [tenantId])
    ).rows.map((r) => r.id);
    // These tables are created by the app on first start; skip any that don't exist yet.
    const exists = async (table: string) =>
      (await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0].ok as boolean;
    if (sessions.length) {
      for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
        if (await exists(table)) {
          await client.query(`DELETE FROM ${table} WHERE thread_id = ANY($1::text[])`, [sessions]);
        }
      }
    }
    const chunks = (await exists("document_chunks"))
      ? await client.query(`DELETE FROM document_chunks WHERE metadata->>'tenantId' = $1`, [tenantId])
      : { rowCount: 0 };
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]); // cascades to the tenant-scoped tables
    await client.query("COMMIT");

    console.log(`Removed tenant "${slug}": ${chunks.rowCount ?? 0} chunks, ${sessions.length} sessions and all its rows.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`\nStill to do by hand (compose is static):`);
  console.log(`  1. delete the "tenant-${slug}-neo4j" service from docker-compose.yml`);
  console.log(`  2. docker compose rm -sf tenant-${slug}-neo4j && docker volume rm <project>_tenant_${slug.replace(/-/g, "_")}_neo4j`);
  console.log(`  3. remove ${defaultPasswordEnv(slug)} from .env and "${slug}" from NEO4J_MCP_HTTP_ALLOWED_URIS`);
  console.log(`  4. restart the app (its cached agent and Neo4j connection for this tenant are in memory)`);
}

async function main() {
  const { command, slug, flags } = parseArgs(process.argv.slice(2));
  if (!command || !slug) {
    console.error("Usage: tenant.ts <add|rotate-key|remove> <slug> [flags]");
    process.exit(1);
  }
  if (command === "add") await add(slug, flags);
  else if (command === "rotate-key") await rotateKey(slug);
  else if (command === "remove") await remove(slug, flags);
  else throw new Error(`Unknown command "${command}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
