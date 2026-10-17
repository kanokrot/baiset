import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DocumentService } from '../../core/src/index.js';
import type { CreateDocumentInput } from '../../core/src/index.js';
import { repositoryContract } from '../../core/test/repository-contract.js';
import { PostgresDocumentRepository } from '../src/index.js';

let container: StartedPostgreSqlContainer;
let adminPool: Pool;
let applicationPool: Pool;
let repositoryA: PostgresDocumentRepository;
let repositoryB: PostgresDocumentRepository;
let restrictedRepository: PostgresDocumentRepository;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const config = { connectionString: container.getConnectionUri() };
  adminPool = new Pool(config);
  repositoryA = new PostgresDocumentRepository(config);
  repositoryB = new PostgresDocumentRepository(config);
  await repositoryA.migrate();
  await adminPool.query("ALTER ROLE thai_docs_app LOGIN PASSWORD 'thai-docs-test-only-password'");
  const applicationUrl = new URL(container.getConnectionUri());
  applicationUrl.username = 'thai_docs_app';
  applicationUrl.password = 'thai-docs-test-only-password';
  applicationPool = new Pool({ connectionString: applicationUrl.toString() });
  restrictedRepository = new PostgresDocumentRepository({
    connectionString: applicationUrl.toString(),
  });
}, 120_000);

afterAll(async () => {
  await Promise.all([
    repositoryA?.close(),
    repositoryB?.close(),
    restrictedRepository?.close(),
    applicationPool?.end(),
    adminPool?.end(),
  ]);
  await container?.stop();
}, 120_000);

repositoryContract('PostgreSQL', async () => {
  await adminPool.query('TRUNCATE documents, document_counters, audit_entries RESTART IDENTITY');
  await adminPool.query('UPDATE audit_anchor SET entry_count=0, head_hash=NULL WHERE singleton=1');
  return {
    repositories: [repositoryA, repositoryB],
    async cleanup() {},
    async assertAuditRowsProtected() {
      const owner = await adminPool.query<{ current_user: string; tableowner: string }>(
        `SELECT current_user, tableowner FROM pg_tables
         WHERE schemaname='public' AND tablename='audit_entries'`,
      );
      expect(owner.rows[0]?.tableowner).toBe(owner.rows[0]?.current_user);
      await expect(adminPool.query('UPDATE audit_entries SET json=json')).rejects.toThrow(
        /append-only/,
      );
      await expect(adminPool.query('DELETE FROM audit_entries')).rejects.toThrow(/append-only/);
    },
    async assertSecretNotPersisted(secret) {
      const rows = await adminPool.query(
        'SELECT json::text FROM audit_entries UNION ALL SELECT json::text FROM documents',
      );
      expect(JSON.stringify(rows.rows)).not.toContain(secret);
    },
  };
});

it('runs service operations as thai_docs_app and limits its table privileges', async () => {
  await adminPool.query('TRUNCATE documents, document_counters, audit_entries RESTART IDENTITY');
  await adminPool.query('UPDATE audit_anchor SET entry_count=0, head_hash=NULL WHERE singleton=1');

  const identity = await applicationPool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0]?.current_user).toBe('thai_docs_app');
  const connectionPrivileges = await adminPool.query<{
    can_connect: boolean;
    can_use_schema: boolean;
  }>(`SELECT has_database_privilege('thai_docs_app', current_database(), 'CONNECT') AS can_connect,
            has_schema_privilege('thai_docs_app', 'public', 'USAGE') AS can_use_schema`);
  expect(connectionPrivileges.rows[0]).toEqual({ can_connect: true, can_use_schema: true });

  const privilegeResult = await adminPool.query<{
    table_name: string;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(`SELECT table_name,
       has_table_privilege('thai_docs_app', table_name, 'SELECT') AS can_select,
       has_table_privilege('thai_docs_app', table_name, 'INSERT') AS can_insert,
       has_table_privilege('thai_docs_app', table_name, 'UPDATE') AS can_update,
       has_table_privilege('thai_docs_app', table_name, 'DELETE') AS can_delete
     FROM (VALUES ('documents'), ('document_counters'), ('audit_entries'), ('audit_anchor')) t(table_name)
     ORDER BY table_name`);
  expect(privilegeResult.rows).toEqual([
    {
      table_name: 'audit_anchor',
      can_select: true,
      can_insert: false,
      can_update: true,
      can_delete: false,
    },
    {
      table_name: 'audit_entries',
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    },
    {
      table_name: 'document_counters',
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
    },
    {
      table_name: 'documents',
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
    },
  ]);

  const service = new DocumentService(
    restrictedRepository,
    { vatRateBasisPoints: 700 },
    {
      auditHmacKey: 'restricted-role-test-hmac-key-at-least-32-bytes',
      auditHmacKeyId: 'restricted-role-test-key',
      mode: 'production',
    },
  );
  const input: CreateDocumentInput = {
    id: 'restricted-role-document',
    type: 'invoice',
    series: 'A',
    currency: 'THB',
    sourceDocumentIds: [],
    seller: { name: 'Seller', address: 'Address', taxId: '123' },
    buyer: { name: 'Buyer', address: 'Address' },
    lineItems: [
      { description: 'Work', quantityMilli: 1000, unitPriceSatang: 100, vatTreatment: 'taxable' },
    ],
  };
  await service.createDraft(input, { id: 'maker', roles: ['issuer'] });
  await service.submit(input.id, { id: 'maker', roles: ['issuer'] });
  const issued = await service.issue(input.id, { id: 'checker', roles: ['approver'] });
  expect(issued.status).toBe('issued');
  const voided = await service.void(input.id, 'Test void', { id: 'admin', roles: ['admin'] });
  expect(voided.status).toBe('voided');

  await expect(applicationPool.query('UPDATE audit_entries SET json=json')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(applicationPool.query('DELETE FROM audit_entries')).rejects.toMatchObject({
    code: '42501',
  });
});
