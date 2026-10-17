import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { createAuditEntry } from '@thai-docs/core';
import type {
  AuditAnchor,
  AuditEntry,
  AuditHmacKey,
  BusinessDocument,
  DocumentType,
  NewAuditEntry,
} from '@thai-docs/core';
import type { DocumentRepository, DocumentTransaction } from '@thai-docs/core';

type JsonRow = { json: BusinessDocument | AuditEntry | string };

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

export async function applyPostgresMigrations(
  pool: Pool,
  directory = join(dirname(fileURLToPath(import.meta.url)), '../migrations'),
): Promise<void> {
  const files = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(directory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresDocumentRepository implements DocumentRepository {
  readonly pool: Pool;

  constructor(config: Pool | PoolConfig | string) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(typeof config === 'string' ? { connectionString: config } : config);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    await applyPostgresMigrations(this.pool);
  }

  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(this.makeTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getDocument(id: string): Promise<BusinessDocument | undefined> {
    return this.readDocument(this.pool, id);
  }

  async listAudit(): Promise<AuditEntry[]> {
    const result = await this.pool.query<JsonRow>(
      'SELECT json FROM audit_entries ORDER BY entry_index',
    );
    return result.rows.map((row) => parseJson(row.json) as AuditEntry);
  }

  async getAuditAnchor(): Promise<AuditAnchor> {
    const result = await this.pool.query<{
      entry_count: string | number;
      head_hash: string | null;
    }>('SELECT entry_count, head_hash FROM audit_anchor WHERE singleton=1');
    const row = result.rows[0];
    if (!row) throw new Error('Audit anchor is missing; run repository migrations');
    return { entryCount: Number(row.entry_count), headHash: row.head_hash };
  }

  private makeTransaction(client: PoolClient): DocumentTransaction {
    return {
      getDocument: (id) => this.readDocument(client, id),
      saveDocument: async (document) => {
        await client.query(
          `INSERT INTO documents(id, json) VALUES($1, $2::jsonb)
           ON CONFLICT(id) DO UPDATE SET json=EXCLUDED.json`,
          [document.id, JSON.stringify(document)],
        );
      },
      nextDocumentNumber: async (type: DocumentType, series: string) => {
        await client.query(
          `INSERT INTO document_counters(document_type, series, value) VALUES($1, $2, 0)
           ON CONFLICT(document_type, series) DO NOTHING`,
          [type, series],
        );
        const selected = await client.query<{ value: string | number }>(
          'SELECT value FROM document_counters WHERE document_type=$1 AND series=$2 FOR UPDATE',
          [type, series],
        );
        const next = Number(selected.rows[0]!.value) + 1;
        await client.query(
          'UPDATE document_counters SET value=$3 WHERE document_type=$1 AND series=$2',
          [type, series, next],
        );
        return `${series}-${String(next).padStart(6, '0')}`;
      },
      appendAudit: async (entry: NewAuditEntry, hmacKey?: AuditHmacKey) => {
        // The singleton anchor lock serializes head reads, appends, and anchor updates.
        const result = await client.query<{
          entry_count: string | number;
          head_hash: string | null;
        }>('SELECT entry_count, head_hash FROM audit_anchor WHERE singleton=1 FOR UPDATE');
        const row = result.rows[0];
        if (!row) throw new Error('Audit anchor is missing; run repository migrations');
        const count = Number(row.entry_count);
        const auditEntry = createAuditEntry(entry, count, row.head_hash, hmacKey);
        await client.query(
          'INSERT INTO audit_entries(entry_index, id, json) VALUES($1, $2, $3::jsonb)',
          [auditEntry.index, auditEntry.id, JSON.stringify(auditEntry)],
        );
        await client.query(
          'UPDATE audit_anchor SET entry_count=$1, head_hash=$2 WHERE singleton=1',
          [count + 1, auditEntry.hash],
        );
        return auditEntry;
      },
      listAudit: async () => {
        const result = await client.query<JsonRow>(
          'SELECT json FROM audit_entries ORDER BY entry_index',
        );
        return result.rows.map((row) => parseJson(row.json) as AuditEntry);
      },
      getAuditAnchor: async () => {
        const result = await client.query<{
          entry_count: string | number;
          head_hash: string | null;
        }>('SELECT entry_count, head_hash FROM audit_anchor WHERE singleton=1');
        const row = result.rows[0];
        if (!row) throw new Error('Audit anchor is missing; run repository migrations');
        return { entryCount: Number(row.entry_count), headHash: row.head_hash };
      },
    };
  }

  private async readDocument(
    executor: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    id: string,
  ): Promise<BusinessDocument | undefined> {
    const result = await executor.query<JsonRow>('SELECT json FROM documents WHERE id=$1', [id]);
    const row = result.rows[0];
    return row ? (parseJson(row.json) as BusinessDocument) : undefined;
  }
}

export function openPostgresRepository(connectionString: string): PostgresDocumentRepository {
  return new PostgresDocumentRepository(connectionString);
}
