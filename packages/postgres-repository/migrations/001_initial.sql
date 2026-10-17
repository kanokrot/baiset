CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY,
  json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS document_counters (
  document_type text NOT NULL,
  series text NOT NULL,
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (document_type, series)
);

CREATE TABLE IF NOT EXISTS audit_entries (
  entry_index bigint PRIMARY KEY,
  id text NOT NULL UNIQUE,
  json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_anchor (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  entry_count bigint NOT NULL CHECK (entry_count >= 0),
  head_hash text
);
INSERT INTO audit_anchor(singleton, entry_count, head_hash)
VALUES (1, 0, NULL) ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit entries are append-only';
END;
$$;
DROP TRIGGER IF EXISTS audit_no_update ON audit_entries;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS audit_no_delete ON audit_entries;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'thai_docs_app') THEN
    CREATE ROLE thai_docs_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
ALTER ROLE thai_docs_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO thai_docs_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO thai_docs_app;
REVOKE ALL ON documents, document_counters, audit_entries, audit_anchor FROM thai_docs_app;
REVOKE ALL ON documents, document_counters, audit_entries, audit_anchor FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON documents, document_counters TO thai_docs_app;
GRANT SELECT, INSERT ON audit_entries TO thai_docs_app;
GRANT SELECT, UPDATE ON audit_anchor TO thai_docs_app;
