import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect } from 'vitest';
import { repositoryContract } from '../../core/test/repository-contract.js';
import { SqliteDocumentRepository } from '../src/index.js';

const databases: Database.Database[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const file of files.splice(0)) {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});

repositoryContract('SQLite', async () => {
  const file = resolve(process.cwd(), `.sqlite-contract-${randomUUID()}.db`);
  files.push(file);
  const dbA = new Database(file);
  const dbB = new Database(file);
  databases.push(dbA, dbB);
  return {
    repositories: [new SqliteDocumentRepository(dbA), new SqliteDocumentRepository(dbB)],
    async cleanup() {},
    async assertAuditRowsProtected() {
      for (const sql of ['UPDATE audit_entries SET json=json', 'DELETE FROM audit_entries']) {
        expect(() => dbA.exec(sql)).toThrow();
      }
    },
    async assertSecretNotPersisted(secret) {
      const rows = dbA
        .prepare('SELECT json FROM audit_entries UNION ALL SELECT json FROM documents')
        .all();
      expect(JSON.stringify(rows)).not.toContain(secret);
    },
  };
});
