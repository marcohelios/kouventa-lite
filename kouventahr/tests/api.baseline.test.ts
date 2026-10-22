/**
 * Phase 0 baseline / contract-first test suite.
 *
 * Purpose: lock in what the CURRENT TypeScript API actually returns,
 * before any Go code exists. These fixtures become your parity test
 * data later — when you port an endpoint to Go, you replay the exact
 * same requests against Go and diff the responses against what's
 * saved here.
 *
 * Run: npx vitest run tests/api.baseline.test.ts
 *
 * Requires the app + postgres + ollama containers running
 * (docker compose up) and a `nomic-embed-text` + `llama3.1:8b`
 * model already pulled in the ollama container.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

beforeAll(() => {
  if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

// Saves the request/response pair as JSON — this IS the contract-first
// artifact. Diff future Go responses against these files.
function saveFixture(name: string, data: unknown) {
  fs.writeFileSync(
    path.join(FIXTURE_DIR, `${name}.json`),
    JSON.stringify(data, null, 2)
  );
}

describe('Kouventa HR API — baseline contract', () => {
  let uploadedDocId: string;

  it('GET /api/documents — empty or existing list shape', async () => {
    const res = await request(BASE_URL).get('/api/documents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    saveFixture('get-documents-200', { status: res.status, body: res.body });
  });

  it('POST /api/upload — happy path with a real PDF', async () => {
    // Put a small real PDF at tests/fixtures/input/sample.pdf before running.
    const samplePath = path.join(__dirname, 'fixtures', 'input', 'sample.pdf');
    if (!fs.existsSync(samplePath)) {
      console.warn('Skipping upload test — add tests/fixtures/input/sample.pdf first');
      return;
    }
    const res = await request(BASE_URL)
      .post('/api/upload')
      .attach('file', samplePath);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.chunksCreated).toBe('number');
    uploadedDocId = res.body.documentId; // capture if you add this field
    saveFixture('post-upload-200', { status: res.status, body: res.body });
  });

  it('POST /api/upload — no file attached (edge case)', async () => {
    const res = await request(BASE_URL).post('/api/upload');
    expect(res.status).toBe(400);
    saveFixture('post-upload-400-nofile', { status: res.status, body: res.body });
  });

  it('POST /api/chat — basic question, no documentId filter', { timeout: 90000 }, async () => {
    const res = await request(BASE_URL)
      .post('/api/chat')
      .send({ message: 'What is this document about?' })
      .buffer(true)
      .parse((res, cb) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => cb(null, raw));
      });

    // SSE responses aren't plain JSON — capture the raw stream text
    // as the fixture so you can diff Go's stream framing later.
    saveFixture('post-chat-sse-raw', { status: res.status, raw: res.body });
  });

  it('POST /api/chat — missing message (edge case)', async () => {
    const res = await request(BASE_URL).post('/api/chat').send({});
    expect(res.status).toBe(400);
    saveFixture('post-chat-400-nomessage', { status: res.status, body: res.body });
  });

  it('DELETE /api/documents/:id — nonexistent id (edge case)', async () => {
    const res = await request(BASE_URL).delete('/api/documents/does-not-exist');
    saveFixture('delete-document-nonexistent', { status: res.status, body: res.body });
    // Note current behavior rather than assuming: Prisma throws on a
    // delete-by-missing-id, so this likely comes back as a 500 today.
    // That's a real discrepancy to log per review point #2 — decide
    // consciously in Go whether to keep the 500 or make it a 404.
  });
});