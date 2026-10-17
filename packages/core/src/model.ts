import type { CreateDocumentInput, LineItem, Party } from './schemas.js';

export type DocumentStatus = 'draft' | 'pending_approval' | 'issued' | 'voided' | 'adjusted';

export interface DocumentTotals {
  subtotalSatang: number;
  vatSatang: number;
  totalSatang: number;
}

export interface BusinessDocument extends CreateDocumentInput {
  title?: string;
  issueDate?: string;
  status: DocumentStatus;
  number?: string;
  totals: DocumentTotals;
  approvedBy?: string;
  issuedAt?: string;
  voidedAt?: string;
  voidReason?: string;
  contentHash?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  index: number;
  id: string;
  keyId: string;
  documentId: string;
  actorId: string;
  action: 'created' | 'edited' | 'submitted' | 'issued' | 'voided' | 'adjusted';
  at: string;
  previousHash: string | null;
  hash: string;
}

export interface AuditAnchor {
  entryCount: number;
  headHash: string | null;
}
export type NewAuditEntry = Omit<AuditEntry, 'id' | 'index' | 'previousHash' | 'hash'>;

export type { LineItem, Party };
