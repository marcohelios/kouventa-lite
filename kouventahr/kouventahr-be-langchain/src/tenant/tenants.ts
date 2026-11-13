import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db';

export interface Neo4jConnection {
  uri: string;
  user: string;
  password: string;
}

export interface Tenant {
  id: string;
  slug: string;
  neo4j: Neo4jConnection;
}

interface TenantRow {
  id: string;
  slug: string;
  neo4j_uri: string;
  neo4j_user: string;
  neo4j_password_env: string;
}

export const hashApiKey = (rawKey: string) => createHash('sha256').update(rawKey).digest('hex');

/** 256 random bits; shown to the operator once, only its hash is stored. */
export const generateApiKey = () => `kvt_${randomBytes(32).toString('base64url')}`;

/** Neo4j passwords live in the environment (.env); the tenant row stores only the variable's name. */
export function toTenant(row: TenantRow): Tenant {
  const password = process.env[row.neo4j_password_env];
  if (!password) throw new Error(`Environment variable ${row.neo4j_password_env} is not set (tenant "${row.slug}")`);
  return { id: row.id, slug: row.slug, neo4j: { uri: row.neo4j_uri, user: row.neo4j_user, password } };
}

const TENANT_COLUMNS = 'id, slug, neo4j_uri, neo4j_user, neo4j_password_env';

/** Resolves a raw API key to its tenant, or undefined when the key is unknown. */
export async function resolveTenantByKey(rawKey: string): Promise<Tenant | undefined> {
  const { rows } = await pool.query<TenantRow>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE api_key_hash = $1`,
    [hashApiKey(rawKey)]
  );
  return rows[0] ? toTenant(rows[0]) : undefined;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | undefined> {
  const { rows } = await pool.query<TenantRow>(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE slug = $1`, [slug]);
  return rows[0] ? toTenant(rows[0]) : undefined;
}
