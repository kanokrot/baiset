ALTER ROLE baiset_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO baiset_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO baiset_app;
REVOKE ALL ON documents, document_counters, audit_entries, audit_anchor FROM baiset_app;
REVOKE ALL ON documents, document_counters, audit_entries, audit_anchor FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON documents, document_counters TO baiset_app;
GRANT SELECT, INSERT ON audit_entries TO baiset_app;
GRANT SELECT, UPDATE ON audit_anchor TO baiset_app;
