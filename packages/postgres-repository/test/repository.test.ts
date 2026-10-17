import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

function logTestPoolErrors(pool: Pool): void {
  pool.on('error', (error: Error): void => {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
    console.error('PostgreSQL test idle pool client error', { code });
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const config = { connectionString: container.getConnectionUri() };
  adminPool = new Pool(config);
  logTestPoolErrors(adminPool);
  repositoryA = new PostgresDocumentRepository(config);
  repositoryB = new PostgresDocumentRepository(config);
  await repositoryA.migrate();
  await adminPool.query("ALTER ROLE baiset_app LOGIN PASSWORD 'baiset-test-only-password'");
  const applicationUrl = new URL(container.getConnectionUri());
  applicationUrl.username = 'baiset_app';
  applicationUrl.password = 'baiset-test-only-password';
  applicationPool = new Pool({ connectionString: applicationUrl.toString() });
  logTestPoolErrors(applicationPool);
  restrictedRepository = new PostgresDocumentRepository({
    connectionString: applicationUrl.toString(),
  });
}, 120_000);

afterAll(async () => {
  const closeResults = await Promise.allSettled([
    repositoryA?.close(),
    repositoryB?.close(),
    restrictedRepository?.close(),
    applicationPool?.end(),
    adminPool?.end(),
  ]);
  await container?.stop();
  const closeFailures = closeResults.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (closeFailures.length > 0) {
    throw new AggregateError(
      closeFailures.map(({ reason }) => reason),
      'Failed to close all PostgreSQL pools and repositories',
    );
  }
}, 120_000);

repositoryContract('PostgreSQL', async () => {
  await adminPool.query('TRUNCATE documents, document_counters, audit_entries RESTART IDENTITY');
  await adminPool.query('UPDATE audit_anchor SET entry_count=0, head_hash=NULL WHERE singleton=1');
  return {
    repositories: [repositoryA, repositoryB],
    async cleanup(): Promise<void> {},
    async assertAuditRowsProtected(): Promise<void> {
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
    async assertSecretNotPersisted(secret): Promise<void> {
      const rows = await adminPool.query(
        'SELECT json::text FROM audit_entries UNION ALL SELECT json::text FROM documents',
      );
      expect(JSON.stringify(rows.rows)).not.toContain(secret);
    },
  };
});

it('runs service operations as baiset_app and limits its table privileges', async () => {
  await adminPool.query('TRUNCATE documents, document_counters, audit_entries RESTART IDENTITY');
  await adminPool.query('UPDATE audit_anchor SET entry_count=0, head_hash=NULL WHERE singleton=1');

  const identity = await applicationPool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0]?.current_user).toBe('baiset_app');
  const connectionPrivileges = await adminPool.query<{
    can_connect: boolean;
    can_use_schema: boolean;
  }>(`SELECT has_database_privilege('baiset_app', current_database(), 'CONNECT') AS can_connect,
            has_schema_privilege('baiset_app', 'public', 'USAGE') AS can_use_schema`);
  expect(connectionPrivileges.rows[0]).toEqual({ can_connect: true, can_use_schema: true });

  const privilegeResult = await adminPool.query<{
    table_name: string;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(`SELECT table_name,
       has_table_privilege('baiset_app', table_name, 'SELECT') AS can_select,
       has_table_privilege('baiset_app', table_name, 'INSERT') AS can_insert,
       has_table_privilege('baiset_app', table_name, 'UPDATE') AS can_update,
       has_table_privilege('baiset_app', table_name, 'DELETE') AS can_delete
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

it('handles the server terminating an idle pooled connection', async () => {
  const idlePoolError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
  try {
    const client = await repositoryA.pool.connect();
    let backendPid: number | undefined;
    try {
      const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      backendPid = result.rows[0]?.pid;
    } finally {
      client.release();
    }
    expect(backendPid).toBeDefined();

    const terminated = await adminPool.query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1) AS terminated',
      [backendPid],
    );
    expect(terminated.rows[0]?.terminated).toBe(true);
    await vi.waitFor(() => {
      expect(idlePoolError).toHaveBeenCalledWith(
        'PostgreSQL idle pool client error',
        expect.objectContaining({ code: expect.any(String) }),
      );
    });
    await expect(repositoryA.pool.query('SELECT 1 AS ok')).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  } finally {
    idlePoolError.mockRestore();
  }
});
