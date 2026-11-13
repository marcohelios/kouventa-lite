import { getTenantBySlug, type Tenant } from "../../src/tenant/tenants";

/**
 * Dev scripts act on one tenant: pass `--tenant <slug>` (or set TENANT=<slug>).
 * Returns the slug and the remaining arguments.
 */
export function takeTenantArg(argv: string[]): { slug: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let slug = process.env.TENANT || undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") slug = argv[++i];
    else rest.push(argv[i]);
  }
  return { slug, rest };
}

/**
 * Loads a tenant for a script. The stored Neo4j URI is the in-compose hostname, which a script run
 * on the host can't resolve; set NEO4J_URI_OVERRIDE (e.g. bolt://localhost:7688) to reach the tenant's
 * published port instead.
 */
export async function requireTenant(slug: string | undefined): Promise<Tenant> {
  if (!slug) throw new Error("Pass --tenant <slug> (or set TENANT=<slug>)");
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown tenant "${slug}"`);
  const override = process.env.NEO4J_URI_OVERRIDE;
  return override ? { ...tenant, neo4j: { ...tenant.neo4j, uri: override } } : tenant;
}
