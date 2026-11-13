import { Document } from "@langchain/core/documents";
import { randomUUID } from "node:crypto";
import { config } from "../config/config";
import * as db from "../db";
import type { Tenant } from "../tenant/tenants";
import { getGraph } from "./neo4j";
import { getChunksByDocumentId, cleanChunks } from "./chunk";
import { buildTransformer } from "./transformer";
import { removeDocumentGraph, writeChunkGraph } from "./store";
import { HttpError } from "./httpError";

export interface Job {
  id: string;
  tenantId: string;
  documentId: string;
  status: "running" | "done" | "failed" | "cancelled";
  total: number;
  processed: number;
  failed: number;
  error?: string;
  cancelRequested: boolean;
}

const jobs = new Map<string, Job>();

/** A job is only visible to the tenant that started it. */
export function getJob(tenantId: string, id: string): Job | undefined {
  const job = jobs.get(id);
  return job?.tenantId === tenantId ? job : undefined;
}

/** Most recent job for a document (running one wins). */
export function getJobForDocument(tenantId: string, documentId: string): Job | undefined {
  let latest: Job | undefined;
  for (const job of jobs.values()) {
    if (job.tenantId !== tenantId || job.documentId !== documentId) continue;
    if (job.status === "running") return job;
    latest = job;
  }
  return latest;
}

const runningJob = (tenantId: string) =>
  [...jobs.values()].find((j) => j.tenantId === tenantId && j.status === "running");

/** True while this document's graph is being built (it creates nodes, so type changes must wait). */
export const isBuildRunning = (tenantId: string, documentId: string) =>
  [...jobs.values()].some((j) => j.tenantId === tenantId && j.documentId === documentId && j.status === "running");

export function cancelJob(tenantId: string, id: string): boolean {
  const job = getJob(tenantId, id);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}

/** Validates, marks the document as building and starts the job in the background. */
export async function startBuild(
  tenant: Tenant,
  documentId: string,
  nodeTypes: string[],
  relTypes: string[]
): Promise<Job> {
  const doc = await db.getDocument(tenant.id, documentId);
  if (!doc) throw new HttpError(404, "Document not found");
  if (doc.graphStatus === "done") throw new HttpError(409, "This document already has a graph");
  // One build at a time per tenant: each chunk is an Azure call and we don't want to hit rate limits.
  if (doc.graphStatus === "building" || runningJob(tenant.id)) {
    throw new HttpError(409, "A graph build is already running");
  }

  await db.setGraphStatus(tenant.id, documentId, { status: "building" });
  const job: Job = {
    id: randomUUID(),
    tenantId: tenant.id,
    documentId,
    status: "running",
    total: 0,
    processed: 0,
    failed: 0,
    cancelRequested: false,
  };
  jobs.set(job.id, job);

  void runJob(tenant, job, nodeTypes, relTypes);
  return job;
}

/** Runs async tasks one after another, so Neo4j writes never interleave. */
function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function runJob(tenant: Tenant, job: Job, nodeTypes: string[], relTypes: string[]): Promise<void> {
  try {
    const graph = await getGraph(tenant);
    await removeDocumentGraph(graph, job.documentId); // a retry starts from a clean slate

    const chunks = cleanChunks(await getChunksByDocumentId(tenant.id, job.documentId));
    if (chunks.length === 0) throw new Error("Document has no usable text chunks");
    job.total = chunks.length;

    const transformer = buildTransformer(nodeTypes, relTypes);
    const serialWrite = createMutex();

    const processChunk = async (chunk: Document) => {
      // LLM extraction runs concurrently; Neo4j writes are serialised.
      const [graphDoc] = await transformer.convertToGraphDocuments([chunk]);
      await serialWrite(() => writeChunkGraph(graph, graphDoc, job.documentId));
    };

    let next = 0;
    let firstError = "";
    const worker = async () => {
      while (!job.cancelRequested) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          try {
            await processChunk(chunks[i]);
          } catch {
            await processChunk(chunks[i]); // one retry
          }
        } catch (err) {
          job.failed++;
          firstError ||= (err as Error).message;
          console.warn(`Graph build: chunk ${i + 1}/${chunks.length} failed:`, (err as Error).message);
        }
        job.processed++;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.graphBuildConcurrency) }, worker));

    if (job.cancelRequested) {
      job.status = "cancelled";
      job.error = "Cancelled by user";
    } else if (job.failed === chunks.length) {
      // Surface the cause in the UI; otherwise it only shows up in the server log.
      throw new Error(`Every chunk failed to process. First error: ${firstError}`);
    } else {
      job.status = "done";
    }
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
  }

  try {
    if (job.status === "done") {
      await db.setGraphStatus(tenant.id, job.documentId, {
        status: "done",
        builtNow: true,
        chunksTotal: job.total,
        chunksFailed: job.failed,
      });
    } else {
      // Don't leave a half-built graph behind for chat to pick up.
      await removeDocumentGraph(await getGraph(tenant), job.documentId).catch(() => undefined);
      await db.setGraphStatus(tenant.id, job.documentId, {
        status: "failed",
        error: job.error ?? "Build failed",
        chunksTotal: job.total,
        chunksFailed: job.failed,
      });
    }
  } catch (err) {
    console.error("Graph build: could not record final status:", err);
  }
}
