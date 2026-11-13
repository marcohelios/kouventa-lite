import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph";
import type { Neo4jConnection, Tenant } from "../tenant/tenants";

/**
 * Idempotent per-database setup. Every document is its own graph inside the tenant's database,
 * marked by a `graphId` property (= the document id) on entities, relationships and chunk nodes.
 */
export async function ensureIndexes(graph: Neo4jGraph): Promise<void> {
  // LangChain's addGraphDocuments used to create a global (id) uniqueness constraint on __Entity__.
  // With one graph per document the same name must be allowed once per graph, so it has to go.
  const legacy = await graph.query(
    "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties " +
      "WHERE labelsOrTypes = ['__Entity__'] AND properties = ['id'] RETURN name"
  );
  for (const row of legacy) await graph.query(`DROP CONSTRAINT \`${row.name}\` IF EXISTS`);

  // An entity name is unique within its graph (these also serve as the graphId lookup indexes).
  await graph.query(
    "CREATE CONSTRAINT entity_graph_id IF NOT EXISTS FOR (n:__Entity__) REQUIRE (n.graphId, n.id) IS UNIQUE"
  );
  await graph.query(
    "CREATE CONSTRAINT document_graph_id IF NOT EXISTS FOR (d:Document) REQUIRE (d.graphId, d.id) IS UNIQUE"
  );
  await graph.query("CREATE FULLTEXT INDEX entity IF NOT EXISTS FOR (e:__Entity__) ON EACH [e.id]");
  await graph.query("DROP INDEX document_documentId IF EXISTS");
}

export async function createGraph(conn: Neo4jConnection): Promise<Neo4jGraph> {
  return await Neo4jGraph.initialize({
    url: conn.uri,
    username: conn.user,
    password: conn.password,
  });
}

// One connection per tenant, each to that tenant's own Neo4j container.
const graphs = new Map<string, Promise<Neo4jGraph>>();

/** Shared connection for a tenant. A failed connect is not cached, so the next request retries. */
export function getGraph(tenant: Tenant): Promise<Neo4jGraph> {
  let pending = graphs.get(tenant.id);
  if (!pending) {
    pending = createGraph(tenant.neo4j)
      .then(async (graph) => {
        await ensureIndexes(graph);
        return graph;
      })
      .catch((err) => {
        graphs.delete(tenant.id);
        throw err;
      });
    graphs.set(tenant.id, pending);
  }
  return pending;
}

async function closeOne(pending: Promise<Neo4jGraph>): Promise<void> {
  try {
    await (await pending).close();
  } catch {
    // connection never opened, nothing to close
  }
}

/** Drops a tenant's cached connection (e.g. after its key or container changed). */
export async function evictGraph(tenantId: string): Promise<void> {
  const pending = graphs.get(tenantId);
  graphs.delete(tenantId);
  if (pending) await closeOne(pending);
}

export async function closeGraph(): Promise<void> {
  const all = [...graphs.values()];
  graphs.clear();
  await Promise.all(all.map(closeOne));
}
