import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph";
import * as db from "../db";
import type { Tenant } from "../tenant/tenants";
import { HttpError } from "./httpError";
import { isBuildRunning } from "./buildJob";
import { getTypeUsage, renameNodeLabel } from "./store";

/**
 * Node types of one document's graph = what is in use in it (derived live from Neo4j) ∪ the
 * document's saved list in Postgres (starter + custom types, which may have zero nodes yet).
 */
export interface TypeInfo {
  name: string;
  nodes: number;
  /** In the saved list (starter or custom), as opposed to only existing because nodes carry it. */
  saved: boolean;
}

const MAX_LENGTH = 60;
const lower = (s: string) => s.toLowerCase();

/** Trims, collapses spaces, and allows letters, digits and spaces only. Case is kept as typed. */
export function cleanTypeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new HttpError(400, "Type name is required");
  if (name.length > MAX_LENGTH) throw new HttpError(400, `Type name must be at most ${MAX_LENGTH} characters`);
  if (!/^[\p{L}\p{N} ]+$/u.test(name)) throw new HttpError(400, "Type name can only contain letters, numbers and spaces");
  return name;
}

export async function listTypes(tenant: Tenant, graph: Neo4jGraph, documentId: string): Promise<TypeInfo[]> {
  const [usage, saved] = await Promise.all([
    getTypeUsage(graph, documentId),
    db.listSavedNodeTypes(tenant.id, documentId),
  ]);
  const all: TypeInfo[] = usage.map((u) => ({ ...u, saved: false }));
  for (const name of saved) {
    const match = all.find((t) => lower(t.name) === lower(name));
    if (match) match.saved = true;
    else all.push({ name, nodes: 0, saved: true });
  }
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

const findType = (types: TypeInfo[], name: string) => types.find((t) => lower(t.name) === lower(name));

/** Maps user input to the canonical available type, or answers 400 (types can't be made on the fly). */
export async function resolveType(tenant: Tenant, graph: Neo4jGraph, documentId: string, raw: unknown): Promise<string> {
  const name = cleanTypeName(raw);
  const match = findType(await listTypes(tenant, graph, documentId), name);
  if (!match) throw new HttpError(400, `Unknown type "${name}". Add it in Manage types first.`);
  return match.name;
}

export async function createType(tenant: Tenant, graph: Neo4jGraph, documentId: string, raw: unknown): Promise<string> {
  const name = cleanTypeName(raw);
  const existing = findType(await listTypes(tenant, graph, documentId), name);
  if (existing) throw new HttpError(409, `"${existing.name}" already exists`);
  await db.addSavedNodeType(tenant.id, documentId, name);
  return name;
}

export async function renameType(
  tenant: Tenant,
  graph: Neo4jGraph,
  documentId: string,
  current: string,
  rawNew: unknown
): Promise<{ name: string; merged: boolean; relabeled: number }> {
  const next = cleanTypeName(rawNew);
  const types = await listTypes(tenant, graph, documentId);
  const cur = findType(types, current);
  if (!cur) throw new HttpError(404, "Type not found");
  if (next === cur.name) throw new HttpError(400, "Nothing to change");
  if (isBuildRunning(tenant.id, documentId)) throw new HttpError(409, "A graph build is running; try again when it finishes");

  // Renaming onto another existing type merges into it and keeps that type's spelling.
  const other = types.find((t) => lower(t.name) === lower(next) && lower(t.name) !== lower(cur.name));
  const finalName = other?.name ?? next;

  const relabeled = cur.nodes > 0 ? await renameNodeLabel(graph, documentId, cur.name, finalName) : 0;
  if (cur.saved) await db.renameSavedNodeType(tenant.id, documentId, cur.name, finalName);
  return { name: finalName, merged: !!other, relabeled };
}

export async function deleteType(tenant: Tenant, graph: Neo4jGraph, documentId: string, current: string): Promise<void> {
  const cur = findType(await listTypes(tenant, graph, documentId), current);
  if (!cur) throw new HttpError(404, "Type not found");
  if (isBuildRunning(tenant.id, documentId)) throw new HttpError(409, "A graph build is running; try again when it finishes");
  if (cur.nodes > 0) {
    throw new HttpError(409, `${cur.nodes} node${cur.nodes === 1 ? "" : "s"} still use "${cur.name}". Change their type first.`);
  }
  await db.deleteSavedNodeType(tenant.id, documentId, cur.name);
}
