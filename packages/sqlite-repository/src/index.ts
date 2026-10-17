import Database from 'better-sqlite3';
import { createAuditEntry } from '@thai-docs/core';
import type {
  AuditAnchor,
  AuditEntry,
  BusinessDocument,
  DocumentType,
  NewAuditEntry,
  AuditHmacKey,
} from '@thai-docs/core';
import type { DocumentRepository, DocumentTransaction } from '@thai-docs/core';

type StoredDocument = { json: string };
let transactionQueue: Promise<void> = Promise.resolve();

export class SqliteDocumentRepository implements DocumentRepository {
  constructor(private readonly db: Database.Database) {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sequences (
        document_type TEXT NOT NULL, series TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY(document_type, series)
      );
      CREATE TABLE IF NOT EXISTS audit_entries (
        entry_index INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_anchor (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), entry_count INTEGER NOT NULL, head_hash TEXT
      );
      INSERT OR IGNORE INTO audit_anchor(singleton, entry_count, head_hash) VALUES (1, 0, NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_entries
        BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_entries
        BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
    `);
  }

  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = transactionQueue;
    transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = await work(this.makeTransaction());
      this.db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      release?.();
    }
  }

  async getDocument(id: string): Promise<BusinessDocument | undefined> {
    return this.readDocument(id);
  }

  async listAudit(): Promise<AuditEntry[]> {
    return this.db
      .prepare('SELECT json FROM audit_entries ORDER BY entry_index')
      .all()
      .map((row) => JSON.parse((row as StoredDocument).json) as AuditEntry);
  }

  async getAuditAnchor(): Promise<AuditAnchor> {
    const row = this.db
      .prepare('SELECT entry_count, head_hash FROM audit_anchor WHERE singleton = 1')
      .get() as { entry_count: number; head_hash: string | null };
    return { entryCount: row.entry_count, headHash: row.head_hash };
  }

  private makeTransaction(): DocumentTransaction {
    return {
      getDocument: async (id): Promise<BusinessDocument | undefined> => this.readDocument(id),
      saveDocument: async (document): Promise<void> => {
        this.db
          .prepare(
            'INSERT INTO documents(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
          )
          .run(document.id, JSON.stringify(document));
      },
      nextDocumentNumber: async (type: DocumentType, series: string): Promise<string> => {
        const row = this.db
          .prepare('SELECT value FROM sequences WHERE document_type=? AND series=?')
          .get(type, series) as { value: number } | undefined;
        const next = (row?.value ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO sequences(document_type, series, value) VALUES(?, ?, ?)
          ON CONFLICT(document_type, series) DO UPDATE SET value=excluded.value`,
          )
          .run(type, series, next);
        return `${series}-${String(next).padStart(6, '0')}`;
      },
      appendAudit: async (entry: NewAuditEntry, hmacKey?: AuditHmacKey): Promise<AuditEntry> => {
        const anchor = await this.getAuditAnchor();
        const auditEntry = createAuditEntry(entry, anchor.entryCount, anchor.headHash, hmacKey);
        this.db
          .prepare('INSERT INTO audit_entries(entry_index, id, json) VALUES(?, ?, ?)')
          .run(auditEntry.index, auditEntry.id, JSON.stringify(auditEntry));
        this.db
          .prepare('UPDATE audit_anchor SET entry_count=?, head_hash=? WHERE singleton=1')
          .run(anchor.entryCount + 1, auditEntry.hash);
        return auditEntry;
      },
      listAudit: (): Promise<AuditEntry[]> => this.listAudit(),
      getAuditAnchor: (): Promise<AuditAnchor> => this.getAuditAnchor(),
    };
  }

  private readDocument(id: string): BusinessDocument | undefined {
    const row = this.db.prepare('SELECT json FROM documents WHERE id=?').get(id) as
      StoredDocument | undefined;
    return row ? (JSON.parse(row.json) as BusinessDocument) : undefined;
  }
}

export function openSqliteRepository(filename: string): SqliteDocumentRepository {
  return new SqliteDocumentRepository(new Database(filename));
}
