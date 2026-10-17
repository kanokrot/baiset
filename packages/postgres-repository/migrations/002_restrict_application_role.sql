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
