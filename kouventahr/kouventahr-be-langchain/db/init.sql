CREATE EXTENSION IF NOT EXISTS vector;

-- One row per tenant. The API key is stored only as a sha256 hash. The Neo4j password is never stored:
-- neo4j_password_env names the environment variable (from .env) that holds it.
CREATE TABLE IF NOT EXISTS tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  api_key_hash       text NOT NULL UNIQUE,
  neo4j_uri          text NOT NULL,
  neo4j_user         text NOT NULL DEFAULT 'neo4j',
  neo4j_password_env text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Everything below is shared between tenants and scoped by tenant_id (enforced in src/db.ts).
CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  chunk_count int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- knowledge-graph build state
  graph_status        text NOT NULL DEFAULT 'none', -- none | building | done | failed
  graph_error         text,
  graph_built_at      timestamptz,
  graph_chunks_total  int  NOT NULL DEFAULT 0,
  graph_chunks_failed int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documents_tenant ON documents (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_sessions_tenant ON chat_sessions (tenant_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Managed knowledge-graph node types. Each document is its own graph with its own list
-- (the starter types are seeded when the document is uploaded).
CREATE TABLE IF NOT EXISTS graph_node_types (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_node_types_doc_name_ci ON graph_node_types (document_id, lower(name));

-- The vector chunk table ("document_chunks") is created by LangChain's
-- PGVectorStore.initialize() on app start. Each chunk carries metadata.tenantId.
