import { z } from 'zod';
import { DomainError } from './errors.js';
import { contentHash } from './crypto.js';
import type { AuditHmacKey } from './crypto.js';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import type { AuditAnchor, BusinessDocument, DocumentStatus } from './model.js';
import type { DocumentRepository, DocumentTransaction } from './repository.js';
import { actorSchema, createDocumentSchema, vatConfigSchema } from './schemas.js';
import type { Actor, CreateDocumentInput, VatConfig } from './schemas.js';
import { calculateTotals } from './totals.js';
import { validateTaxInvoiceRequiredFields } from './tax-invoice-required-fields.js';

export interface DocumentServiceOptions {
  clock?: Clock;
  auditHmacKey?: AuditHmacKey;
  auditHmacKeyId?: string;
  allowUnkeyedAudit?: boolean;
  mode?: 'development' | 'production';
  warningLogger?: (message: string) => void;
  issueDateTimeZone?: string;
}

function parseOrFail<T>(result: { success: boolean; data?: T }): T {
  if (!result.success || result.data === undefined)
    throw new DomainError('VALIDATION_FAILED', 'Input validation failed');
  return result.data;
}

function requireRole(actor: Actor, role: Actor['roles'][number]): void {
  if (!actor.roles.includes(role) && !actor.roles.includes('admin')) {
    throw new DomainError('PERMISSION_DENIED', 'Actor is not permitted to perform this action');
  }
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function parseDocumentId(value: unknown): string {
  const result = z.string().trim().min(1).max(100).safeParse(value);
  if (!result.success) throw new DomainError('VALIDATION_FAILED', 'Document ID is invalid');
  return result.data;
}

async function appendAudit(
  tx: DocumentTransaction,
  documentId: string,
  actorId: string,
  action: 'created' | 'edited' | 'submitted' | 'issued' | 'voided' | 'adjusted',
  at: string,
  keyId: string,
  hmacKey?: AuditHmacKey,
): Promise<void> {
  await tx.appendAudit({ documentId, actorId, action, at, keyId }, hmacKey);
}

function assertSources(
  document: CreateDocumentInput,
  sourceTypes: ReadonlyMap<string, BusinessDocument>,
): void {
  if (
    document.type === 'invoice' &&
    document.sourceDocumentIds.length > 0 &&
    document.sourceDocumentIds.some((id) => sourceTypes.get(id)?.type !== 'purchase_order')
  ) {
    throw new DomainError('SOURCE_INVALID', 'Invoice source must be a purchase order');
  }
  if (
    document.type === 'billing_note' &&
    (document.sourceDocumentIds.length === 0 ||
      document.sourceDocumentIds.some((id) => sourceTypes.get(id)?.type !== 'invoice'))
  ) {
    throw new DomainError('SOURCE_INVALID', 'Billing note sources must be invoices');
  }
  if (
    document.type === 'tax_invoice' &&
    document.sourceDocumentIds.some((id) => sourceTypes.get(id)?.type !== 'invoice')
  ) {
    throw new DomainError('SOURCE_INVALID', 'Tax invoice source must be an invoice');
  }
  if (
    (document.type === 'credit_note' || document.type === 'debit_note') &&
    (document.sourceDocumentIds.length !== 1 ||
      sourceTypes.get(document.sourceDocumentIds[0] ?? '')?.type !== 'tax_invoice')
  ) {
    throw new DomainError(
      'SOURCE_INVALID',
      'Credit and debit notes must reference one tax invoice',
    );
  }
}

export class DocumentService {
  private readonly clock: Clock;
  private readonly auditHmacKey?: AuditHmacKey;
  private readonly auditHmacKeyId: string;
  private readonly issueDateTimeZone: string;
  private readonly vatConfig: VatConfig;

  constructor(
    private readonly repository: DocumentRepository,
    vatConfig: VatConfig,
    options: DocumentServiceOptions = {},
  ) {
    const parsedVat = vatConfigSchema.safeParse(vatConfig);
    if (!parsedVat.success)
      throw new DomainError('VALIDATION_FAILED', 'VAT configuration is invalid');
    this.vatConfig = parsedVat.data;
    this.clock = options.clock ?? systemClock;
    const productionMode = process.env.NODE_ENV === 'production' || options.mode === 'production';
    if (options.auditHmacKey === undefined) {
      if (productionMode)
        throw new DomainError('VALIDATION_FAILED', 'Audit HMAC key is required in production');
      if (options.allowUnkeyedAudit !== true)
        throw new DomainError(
          'VALIDATION_FAILED',
          'Unkeyed audit requires explicit development opt-in',
        );
      this.auditHmacKeyId = 'unkeyed';
      (options.warningLogger ?? console.warn)(
        'SECURITY WARNING: Unkeyed audit is enabled for development.',
      );
    } else {
      const keyIdResult = z.string().trim().min(1).max(128).safeParse(options.auditHmacKeyId);
      if (!keyIdResult.success)
        throw new DomainError('VALIDATION_FAILED', 'Audit key ID is required and must be valid');
      this.auditHmacKeyId = keyIdResult.data;
      if (this.auditHmacKeyId === 'unkeyed')
        throw new DomainError('VALIDATION_FAILED', 'Reserved audit key ID');
    }
    this.issueDateTimeZone = options.issueDateTimeZone ?? 'Asia/Bangkok';
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: this.issueDateTimeZone }).format(new Date(0));
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'Issue date timezone is invalid');
    }
    if (options.auditHmacKey !== undefined) {
      const keyLength =
        typeof options.auditHmacKey === 'string'
          ? Buffer.byteLength(options.auditHmacKey, 'utf8')
          : options.auditHmacKey.byteLength;
      if (keyLength < 32)
        throw new DomainError('VALIDATION_FAILED', 'Audit HMAC key must be at least 32 bytes');
      this.auditHmacKey =
        typeof options.auditHmacKey === 'string'
          ? options.auditHmacKey
          : Uint8Array.from(options.auditHmacKey);
    }
  }

  async exportAnchor(): Promise<AuditAnchor> {
    return detached(await this.repository.getAuditAnchor());
  }

  async createDraft(input: unknown, actorInput: unknown): Promise<BusinessDocument> {
    const documentInput = parseOrFail(createDocumentSchema.safeParse(input));
    const actor = parseOrFail(actorSchema.safeParse(actorInput));
    requireRole(actor, 'issuer');
    return this.repository.transaction(async (tx) => {
      if (await tx.getDocument(documentInput.id))
        throw new DomainError('VALIDATION_FAILED', 'Document ID already exists');
      const sources = await this.loadSources(tx, documentInput.sourceDocumentIds);
      assertSources(documentInput, sources);
      const createdAt = this.timestamp();
      const document: BusinessDocument = {
        ...documentInput,
        ...(documentInput.type === 'tax_invoice'
          ? { title: '\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35' }
          : {}),
        status: 'draft',
        totals: calculateTotals(documentInput.lineItems, this.vatConfig),
        createdBy: actor.id,
        createdAt,
        updatedAt: createdAt,
      };
      await tx.saveDocument(document);
      await appendAudit(
        tx,
        document.id,
        actor.id,
        'created',
        createdAt,
        this.auditHmacKeyId,
        this.auditHmacKey,
      );
      return detached(document);
    });
  }

  async updateDraft(
    documentIdInput: unknown,
    input: unknown,
    actorInput: unknown,
  ): Promise<BusinessDocument> {
    const documentId = parseDocumentId(documentIdInput);
    const documentInput = parseOrFail(createDocumentSchema.safeParse(input));
    const actor = parseOrFail(actorSchema.safeParse(actorInput));
    requireRole(actor, 'issuer');
    return this.repository.transaction(async (tx) => {
      const previous = await this.requireDocument(tx, documentId);
      this.requireStatus(previous, 'draft');
      if (documentInput.id !== previous.id || actor.id !== previous.createdBy) {
        throw new DomainError('PERMISSION_DENIED', 'Only the document creator may edit this draft');
      }
      const sources = await this.loadSources(tx, documentInput.sourceDocumentIds);
      assertSources(documentInput, sources);
      const updatedAt = this.timestamp();
      const updated: BusinessDocument = {
        ...documentInput,
        ...(documentInput.type === 'tax_invoice'
          ? { title: '\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35' }
          : {}),
        status: 'draft',
        totals: calculateTotals(documentInput.lineItems, this.vatConfig),
        createdBy: previous.createdBy,
        createdAt: previous.createdAt,
        updatedAt,
      };
      await tx.saveDocument(updated);
      await appendAudit(
        tx,
        documentId,
        actor.id,
        'edited',
        updatedAt,
        this.auditHmacKeyId,
        this.auditHmacKey,
      );
      return detached(updated);
    });
  }

  async submit(documentIdInput: unknown, actorInput: unknown): Promise<BusinessDocument> {
    const documentId = parseDocumentId(documentIdInput);
    const actor = parseOrFail(actorSchema.safeParse(actorInput));
    requireRole(actor, 'issuer');
    return this.repository.transaction(async (tx) => {
      const document = await this.requireDocument(tx, documentId);
      this.requireStatus(document, 'draft');
      const at = this.timestamp();
      const updated: BusinessDocument = { ...document, status: 'pending_approval', updatedAt: at };
      await tx.saveDocument(updated);
      await appendAudit(
        tx,
        documentId,
        actor.id,
        'submitted',
        at,
        this.auditHmacKeyId,
        this.auditHmacKey,
      );
      return detached(updated);
    });
  }

  async issue(documentIdInput: unknown, actorInput: unknown): Promise<BusinessDocument> {
    const documentId = parseDocumentId(documentIdInput);
    const actor = parseOrFail(actorSchema.safeParse(actorInput));
    requireRole(actor, 'approver');
    return this.repository.transaction(async (tx) => {
      const document = await this.requireDocument(tx, documentId);
      this.requireStatus(document, 'pending_approval');
      if (document.type === 'tax_invoice' && document.createdBy === actor.id) {
        throw new DomainError('PERMISSION_DENIED', 'Tax invoice creator and approver must differ');
      }
      const now = this.currentTime();
      const at = now.toISOString();
      const number = await tx.nextDocumentNumber(document.type, document.series);
      const issuedBase: BusinessDocument = {
        ...document,
        issueDate: this.calendarDate(now),
        status: 'issued',
        number,
        approvedBy: actor.id,
        issuedAt: at,
        updatedAt: at,
      };
      if (issuedBase.type === 'tax_invoice') {
        const issues = validateTaxInvoiceRequiredFields(issuedBase);
        if (issues.length > 0)
          throw new DomainError('TAX_INVOICE_INVALID', 'Tax invoice is missing required fields');
      }
      const issued: BusinessDocument = { ...issuedBase, contentHash: contentHash(issuedBase) };
      await tx.saveDocument(issued);
      await appendAudit(
        tx,
        documentId,
        actor.id,
        'issued',
        at,
        this.auditHmacKeyId,
        this.auditHmacKey,
      );
      if (issued.type === 'credit_note' || issued.type === 'debit_note') {
        const sourceId = issued.sourceDocumentIds[0];
        const source = sourceId ? await tx.getDocument(sourceId) : undefined;
        if (!source || (source.status !== 'issued' && source.status !== 'adjusted')) {
          throw new DomainError('SOURCE_INVALID', 'Adjustment source is not an issued tax invoice');
        }
        const adjusted: BusinessDocument = { ...source, status: 'adjusted', updatedAt: at };
        await tx.saveDocument(adjusted);
        await appendAudit(
          tx,
          source.id,
          actor.id,
          'adjusted',
          at,
          this.auditHmacKeyId,
          this.auditHmacKey,
        );
      }
      return detached(issued);
    });
  }

  async void(
    documentIdInput: unknown,
    reasonInput: unknown,
    actorInput: unknown,
  ): Promise<BusinessDocument> {
    const documentId = parseDocumentId(documentIdInput);
    const actor = parseOrFail(actorSchema.safeParse(actorInput));
    const reasonResult = z.string().trim().min(1).max(1000).safeParse(reasonInput);
    if (!reasonResult.success)
      throw new DomainError('VALIDATION_FAILED', 'Void reason is required');
    requireRole(actor, 'admin');
    return this.repository.transaction(async (tx) => {
      const document = await this.requireDocument(tx, documentId);
      this.requireStatus(document, 'issued');
      const at = this.timestamp();
      const updated: BusinessDocument = {
        ...document,
        status: 'voided',
        voidReason: reasonResult.data,
        voidedAt: at,
        updatedAt: at,
      };
      await tx.saveDocument(updated);
      await appendAudit(
        tx,
        documentId,
        actor.id,
        'voided',
        at,
        this.auditHmacKeyId,
        this.auditHmacKey,
      );
      return detached(updated);
    });
  }

  private timestamp(): string {
    return this.currentTime().toISOString();
  }

  private currentTime(): Date {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new DomainError('VALIDATION_FAILED', 'Configured clock returned an invalid time');
    }
    return now;
  }

  private calendarDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.issueDateTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: 'year' | 'month' | 'day'): string | undefined =>
      parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private async loadSources(
    tx: DocumentTransaction,
    ids: readonly string[],
  ): Promise<Map<string, BusinessDocument>> {
    const sources = new Map<string, BusinessDocument>();
    for (const id of ids) {
      const source = await tx.getDocument(id);
      if (
        !source ||
        source.status === 'draft' ||
        source.status === 'pending_approval' ||
        source.status === 'voided'
      ) {
        throw new DomainError('SOURCE_INVALID', 'Source document is not available');
      }
      sources.set(id, source);
    }
    return sources;
  }

  private async requireDocument(tx: DocumentTransaction, id: string): Promise<BusinessDocument> {
    const document = await tx.getDocument(id);
    if (!document) throw new DomainError('NOT_FOUND', 'Document not found');
    return document;
  }

  private requireStatus(document: BusinessDocument, expected: DocumentStatus): void {
    if (document.status !== expected)
      throw new DomainError('ILLEGAL_TRANSITION', 'Document state does not allow this action');
  }
}
