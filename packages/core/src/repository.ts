import type { AuditAnchor, AuditEntry, BusinessDocument, NewAuditEntry } from './model.js';
import type { DocumentType } from './schemas.js';
import type { AuditHmacKey } from './crypto.js';

export interface DocumentTransaction {
  getDocument(id: string): Promise<BusinessDocument | undefined>;
  saveDocument(document: BusinessDocument): Promise<void>;
  nextDocumentNumber(type: DocumentType, series: string): Promise<string>;
  appendAudit(entry: NewAuditEntry, hmacKey?: AuditHmacKey): Promise<AuditEntry>;
  listAudit(): Promise<AuditEntry[]>;
  getAuditAnchor(): Promise<AuditAnchor>;
}

export interface DocumentRepository {
  transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
  getDocument(id: string): Promise<BusinessDocument | undefined>;
  listAudit(): Promise<AuditEntry[]>;
  getAuditAnchor(): Promise<AuditAnchor>;
}
