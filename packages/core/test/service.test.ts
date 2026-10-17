import { describe, expect, it } from 'vitest';
import {
  calculateVat,
  canonicalJson,
  contentHash,
  createAuditEntry,
  DocumentService,
  DomainError,
  Money,
  validateTaxInvoiceRequiredFields,
  verifyChain,
} from '../src/index.js';
import type {
  AuditAnchor,
  AuditEntry,
  AuditHmacKey,
  BusinessDocument,
  Clock,
  CreateDocumentInput,
  DocumentRepository,
  DocumentTransaction,
  DocumentType,
  NewAuditEntry,
} from '../src/index.js';

class FixedClock implements Clock {
  constructor(private readonly instant = '2026-02-03T04:05:06.000Z') {}

  now(): Date {
    return new Date(this.instant);
  }
}

class MemoryRepository implements DocumentRepository {
  documents = new Map<string, BusinessDocument>();
  audits: AuditEntry[] = [];
  sequences = new Map<string, number>();
  private mutex: Promise<void> = Promise.resolve();

  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.mutex;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const documents = new Map(this.documents);
    const audits = [...this.audits];
    const sequences = new Map(this.sequences);
    const tx: DocumentTransaction = {
      getDocument: async (id) => this.documents.get(id),
      saveDocument: async (document) => {
        this.documents.set(document.id, document);
      },
      nextDocumentNumber: async (type: DocumentType, series: string) => {
        const key = `${type}:${series}`;
        const next = (this.sequences.get(key) ?? 0) + 1;
        this.sequences.set(key, next);
        return `${series}-${String(next).padStart(6, '0')}`;
      },
      appendAudit: async (entry: NewAuditEntry, hmacKey?: AuditHmacKey) => {
        const previousEntry = this.audits.at(-1);
        const result = createAuditEntry(
          entry,
          this.audits.length,
          previousEntry?.hash ?? null,
          hmacKey,
        );
        this.audits.push(result);
        return result;
      },
      listAudit: async () => [...this.audits],
      getAuditAnchor: async () => this.getAuditAnchor(),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.documents = documents;
      this.audits = audits;
      this.sequences = sequences;
      throw error;
    } finally {
      release?.();
    }
  }

  async getDocument(id: string): Promise<BusinessDocument | undefined> {
    return this.documents.get(id);
  }
  async listAudit(): Promise<AuditEntry[]> {
    return [...this.audits];
  }
  async getAuditAnchor(): Promise<AuditAnchor> {
    return { entryCount: this.audits.length, headHash: this.audits.at(-1)?.hash ?? null };
  }
}

const issuer = { id: 'maker', roles: ['issuer'] as const };
const approver = { id: 'checker', roles: ['approver'] as const };
const admin = { id: 'admin-1', roles: ['admin'] as const };
const instant = '2026-02-03T04:05:06.000Z';
const thaiComposed = '\u0e20\u0e32\u0e29\u0e32\u0e44\u0e17\u0e22 Caf\u00e9';
const thaiDecomposed = '\u0e20\u0e32\u0e29\u0e32\u0e44\u0e17\u0e22 Cafe\u0301';
const thaiCanonicalOrder = '\u0e01\u0e38\u0e48';
const thaiNonCanonicalOrder = '\u0e01\u0e48\u0e38';

function makeService(
  repository: DocumentRepository,
  vatRateBasisPoints = 700,
  auditHmacKey?: AuditHmacKey,
  extra: { clock?: Clock; auditHmacKeyId?: string; issueDateTimeZone?: string } = {},
): DocumentService {
  return new DocumentService(
    repository,
    { vatRateBasisPoints },
    {
      clock: extra.clock ?? new FixedClock(),
      ...(auditHmacKey === undefined
        ? { allowUnkeyedAudit: true, warningLogger: (): void => {} }
        : { auditHmacKey, auditHmacKeyId: extra.auditHmacKeyId ?? 'test-key' }),
      ...(extra.issueDateTimeZone === undefined
        ? {}
        : { issueDateTimeZone: extra.issueDateTimeZone }),
    },
  );
}

const baseInput = (
  id: string,
  type: DocumentType = 'invoice',
  sourceDocumentIds: string[] = [],
): CreateDocumentInput => ({
  id,
  type,
  seller: { name: 'Seller', address: 'Seller address', taxId: '123' },
  buyer: { name: 'Buyer', address: 'Buyer address' },
  lineItems: [
    {
      description: 'Service',
      quantityMilli: 1000,
      unitPriceSatang: 10000,
      vatTreatment: 'taxable',
    },
  ],
  sourceDocumentIds,
});

async function createAndSubmit(
  service: DocumentService,
  id: string,
  type: DocumentType = 'invoice',
  sources: string[] = [],
): Promise<void> {
  await service.createDraft(baseInput(id, type, sources), issuer);
  await service.submit(id, issuer);
}

describe('Money and document core', () => {
  it('uses integer satang without accepting fractions', () => {
    expect(Money.fromSatang(101).multiplyRatio(1, 2).satang).toBe(51);
    expect(() => Money.fromSatang(0.5)).toThrow(RangeError);
  });

  it('rounds VAT edges symmetrically, including negative amounts', () => {
    expect(calculateVat(Money.fromSatang(1), 5000).satang).toBe(1);
    expect(calculateVat(Money.fromSatang(3), 5000).satang).toBe(2);
    expect(calculateVat(Money.fromSatang(-1), 5000).satang).toBe(-1);
    expect(calculateVat(Money.fromSatang(-3), 5000).satang).toBe(-2);
  });

  it('normalizes Thai-containing strings to NFC before canonical JSON serialization', () => {
    expect(thaiComposed).not.toBe(thaiDecomposed);
    expect(thaiCanonicalOrder).not.toBe(thaiNonCanonicalOrder);
    expect(thaiCanonicalOrder.normalize('NFC')).toBe(thaiNonCanonicalOrder.normalize('NFC'));
    expect(canonicalJson({ description: thaiComposed })).toBe(
      canonicalJson({ description: thaiDecomposed }),
    );
    expect(canonicalJson({ description: thaiCanonicalOrder })).toBe(
      canonicalJson({ description: thaiNonCanonicalOrder }),
    );
  });

  it('normalizes Thai-containing strings to NFC before content hashing', () => {
    expect(contentHash({ description: thaiComposed })).toBe(
      contentHash({ description: thaiDecomposed }),
    );
  });

  it('derives creation and audit timestamps from the injected clock', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository, 750);
    const draft = await service.createDraft(baseInput('clocked'), issuer);
    expect(draft.createdAt).toBe(instant);
    expect(draft.issueDate).toBeUndefined();
    expect(repository.audits[0]?.at).toBe(instant);
  });

  it('rejects caller-supplied issue and creation dates', async () => {
    const service = makeService(new MemoryRepository());
    await expect(
      service.createDraft({ ...baseInput('caller-date'), issueDate: '1999-01-01' }, issuer),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.createDraft({ ...baseInput('caller-created-at'), createdAt: instant }, issuer),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects caller-supplied audit timestamps', async () => {
    const service = makeService(new MemoryRepository());
    await service.createDraft(baseInput('clocked'), issuer);
    await expect(
      service.submit('clocked', { ...issuer, at: '1999-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it.each([
    [
      '23:30 UTC rolls into the next Bangkok calendar date',
      '2026-02-03T23:30:00.000Z',
      '2026-02-04',
    ],
    [
      '00:30 UTC remains on the same Bangkok calendar date',
      '2026-02-03T00:30:00.000Z',
      '2026-02-03',
    ],
  ])('uses Bangkok issue date: %s', async (_name, time, expectedDate) => {
    const service = makeService(new MemoryRepository(), 700, undefined, {
      clock: new FixedClock(time),
    });
    await createAndSubmit(service, 'date-boundary');
    expect((await service.issue('date-boundary', approver)).issueDate).toBe(expectedDate);
  });

  it('allows issue date timezone to be configured', async () => {
    const service = makeService(new MemoryRepository(), 700, undefined, {
      clock: new FixedClock('2026-02-03T23:30:00.000Z'),
      issueDateTimeZone: 'UTC',
    });
    await createAndSubmit(service, 'utc-date');
    expect((await service.issue('utc-date', approver)).issueDate).toBe('2026-02-03');
  });

  it('requires issuer role to create drafts', async () => {
    const service = makeService(new MemoryRepository());
    const auditor = { id: 'reader', roles: ['auditor'] as const };
    await expect(service.createDraft(baseInput('denied-create'), auditor)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('requires issuer role to edit drafts', async () => {
    const service = makeService(new MemoryRepository());
    const auditor = { id: 'reader', roles: ['auditor'] as const };
    await service.createDraft(baseInput('roles'), issuer);
    await expect(service.updateDraft('roles', baseInput('roles'), auditor)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('requires issuer role to submit drafts', async () => {
    const service = makeService(new MemoryRepository());
    const auditor = { id: 'reader', roles: ['auditor'] as const };
    await service.createDraft(baseInput('roles'), issuer);
    await expect(service.submit('roles', auditor)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('requires approver role to issue pending documents', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'roles');
    await expect(service.issue('roles', issuer)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('requires admin role to void issued documents', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'roles');
    await service.issue('roles', approver);
    await expect(service.void('roles', 'reason', issuer)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('allows edits while a document is in draft state', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await service.createDraft(baseInput('editable'), issuer);
    const changed = baseInput('editable');
    changed.lineItems = [
      {
        description: 'Updated work',
        quantityMilli: 2000,
        unitPriceSatang: 500,
        vatTreatment: 'exempt',
      },
    ];
    const updated = await service.updateDraft('editable', changed, issuer);
    expect(updated.totals).toEqual({ subtotalSatang: 1000, vatSatang: 0, totalSatang: 1000 });
    expect(updated.status).toBe('draft');
  });

  it('audits draft edits', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await service.createDraft(baseInput('editable'), issuer);
    await service.updateDraft('editable', baseInput('editable'), issuer);
    expect(repository.audits.map((entry) => entry.action)).toEqual(['created', 'edited']);
  });

  it('rejects editing after issue', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'editable');
    await service.issue('editable', approver);
    await expect(
      service.updateDraft('editable', baseInput('editable'), issuer),
    ).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('requires a different tax invoice approver', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'tax-1', 'tax_invoice');
    const dualRoleMaker = { id: 'maker', roles: ['issuer', 'approver'] as const };
    await expect(service.issue('tax-1', dualRoleMaker)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('issues a tax invoice with its Thai title and content hash', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'tax-1', 'tax_invoice');
    const tax = await service.issue('tax-1', approver);
    expect(tax.type).toBe('tax_invoice');
    expect(tax.title).toContain(
      '\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35',
    );
    expect(tax.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects tax invoice line items with empty descriptions', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'tax-empty-description', 'tax_invoice');
    const tax = await service.issue('tax-empty-description', approver);
    expect(
      validateTaxInvoiceRequiredFields({
        ...tax,
        lineItems: [{ ...tax.lineItems[0]!, description: '' }],
      }),
    ).toContain('item details are required');
  });

  it('allows an invoice to reference an issued purchase order', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await createAndSubmit(service, 'po-1', 'purchase_order');
    await service.issue('po-1', approver);
    await service.createDraft(baseInput('invoice-1', 'invoice', ['po-1']), issuer);
    await service.submit('invoice-1', issuer);
    const invoice = await service.issue('invoice-1', approver);
    expect(invoice.sourceDocumentIds).toEqual(['po-1']);
  });

  it('allows one billing note to group multiple issued invoices', async () => {
    const service = makeService(new MemoryRepository());
    for (const suffix of ['1', '2']) {
      await createAndSubmit(service, `po-${suffix}`, 'purchase_order');
      await service.issue(`po-${suffix}`, approver);
      await service.createDraft(
        baseInput(`invoice-${suffix}`, 'invoice', [`po-${suffix}`]),
        issuer,
      );
      await service.submit(`invoice-${suffix}`, issuer);
      await service.issue(`invoice-${suffix}`, approver);
    }
    await service.createDraft(
      baseInput('billing-1', 'billing_note', ['invoice-1', 'invoice-2']),
      issuer,
    );
    await service.submit('billing-1', issuer);
    expect((await service.issue('billing-1', approver)).sourceDocumentIds).toHaveLength(2);
  });

  it('adjusts a tax invoice when a linked credit note is issued', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await service.createDraft(baseInput('invoice-1', 'invoice'), issuer);
    await service.submit('invoice-1', issuer);
    await service.issue('invoice-1', approver);
    await service.createDraft(baseInput('tax-source', 'tax_invoice', ['invoice-1']), issuer);
    await service.submit('tax-source', issuer);
    await service.issue('tax-source', approver);
    await service.createDraft(baseInput('credit-1', 'credit_note', ['tax-source']), issuer);
    await service.submit('credit-1', issuer);
    await service.issue('credit-1', approver);
    expect((await repository.getDocument('tax-source'))?.status).toBe('adjusted');
  });

  it('rejects a credit note whose referenced tax invoice has not been issued', async () => {
    const service = makeService(new MemoryRepository());
    await service.createDraft(baseInput('tax-draft', 'tax_invoice'), issuer);
    await expect(
      service.createDraft(baseInput('credit-invalid', 'credit_note', ['tax-draft']), issuer),
    ).rejects.toMatchObject({ code: 'SOURCE_INVALID' });
  });

  it('requires a non-empty void reason', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'doc-void');
    await service.issue('doc-void', approver);
    await expect(service.void('doc-void', '', admin)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('records the reason when voiding a document', async () => {
    const service = makeService(new MemoryRepository());
    await createAndSubmit(service, 'doc-void');
    await service.issue('doc-void', approver);
    const voided = await service.void('doc-void', 'Duplicate', admin);
    expect(voided.status).toBe('voided');
    expect(voided.voidReason).toBe('Duplicate');
  });

  it('allocates gapless unique numbers during concurrent issuance', async () => {
    const service = makeService(new MemoryRepository());
    const ids = Array.from({ length: 30 }, (_, index) => `concurrent-${index}`);
    await Promise.all(ids.map((id) => createAndSubmit(service, id)));
    const issued = await Promise.all(ids.map((id) => service.issue(id, approver)));
    const numbers = issued.map((document) => document.number).sort();
    expect(new Set(numbers).size).toBe(ids.length);
    expect(numbers).toEqual(
      ids.map((_, index) => `A-${String(index + 1).padStart(6, '0')}`).sort(),
    );
  });

  async function getAuditChain(): Promise<{ chain: AuditEntry[]; anchor: AuditAnchor }> {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await createAndSubmit(service, 'audit-doc');
    await service.issue('audit-doc', approver);
    const chain = await repository.listAudit();
    const anchor = await service.exportAnchor();
    expect(chain.map((entry) => entry.id)).toEqual(chain.map((_, index) => `audit:${index}`));
    expect(verifyChain(chain, anchor)).toBe(true);
    return { chain, anchor };
  }

  it('detects an edited audit entry', async () => {
    const { chain, anchor } = await getAuditChain();
    expect(
      verifyChain(
        chain.map((entry, index) => (index === 0 ? { ...entry, actorId: 'tampered' } : entry)),
        anchor,
      ),
    ).toBe(false);
  });

  it('detects deletion of a middle audit entry', async () => {
    const { chain, anchor } = await getAuditChain();
    expect(verifyChain([...chain.slice(0, 1), ...chain.slice(2)], anchor)).toBe(false);
  });

  it('detects deletion of the tail audit entry', async () => {
    const { chain, anchor } = await getAuditChain();
    expect(verifyChain(chain.slice(0, -1), anchor)).toBe(false);
  });

  it('detects reordered audit entries', async () => {
    const { chain, anchor } = await getAuditChain();
    expect(verifyChain([...chain].reverse(), anchor)).toBe(false);
  });

  it('verifies audit chains across key rotation using each entry keyId', async () => {
    const repository = new MemoryRepository();
    const firstKey = 'first-hmac-key-with-at-least-32-bytes';
    const secondKey = 'second-hmac-key-with-at-least-32-bytes';
    const first = makeService(repository, 700, firstKey, { auditHmacKeyId: 'key-1' });
    await first.createDraft(baseInput('rotation'), issuer);
    const second = makeService(repository, 700, secondKey, { auditHmacKeyId: 'key-2' });
    await second.submit('rotation', issuer);
    const chain = await repository.listAudit();
    expect(chain.map((entry) => entry.keyId)).toEqual(['key-1', 'key-2']);
    expect(
      verifyChain(chain, await second.exportAnchor(), { 'key-1': firstKey, 'key-2': secondKey }),
    ).toBe(true);
  });

  it('supports HMAC chaining with the configured key', async () => {
    const repository = new MemoryRepository();
    const key = 'test-hmac-key-with-at-least-32-bytes';
    const service = makeService(repository, 700, key, { auditHmacKeyId: 'key-1' });
    await createAndSubmit(service, 'hmac-doc');
    const chain = await repository.listAudit();
    const anchor = await service.exportAnchor();
    expect(chain.every((entry) => entry.keyId === 'key-1')).toBe(true);
    expect(verifyChain(chain, anchor, { 'key-1': key })).toBe(true);
    expect(verifyChain(chain, anchor, { 'key-1': 'wrong-key-that-is-also-long-enough' })).toBe(
      false,
    );
  });

  it('exports the current audit head hash and count', async () => {
    const repository = new MemoryRepository();
    const service = makeService(repository);
    await createAndSubmit(service, 'anchor-doc');
    const chain = await repository.listAudit();
    expect(await service.exportAnchor()).toEqual({ entryCount: 2, headHash: chain.at(-1)?.hash });
  });

  it('requires keyed audit in production', () => {
    expect(
      () =>
        new DocumentService(
          new MemoryRepository(),
          { vatRateBasisPoints: 700 },
          { mode: 'production' },
        ),
    ).toThrow();
  });

  it('requires explicit development opt-in for unkeyed audit', () => {
    expect(
      () =>
        new DocumentService(
          new MemoryRepository(),
          { vatRateBasisPoints: 700 },
          { mode: 'development' },
        ),
    ).toThrow();
  });

  it('logs a warning when unkeyed development audit is enabled', () => {
    const warnings: string[] = [];
    expect(
      () =>
        new DocumentService(
          new MemoryRepository(),
          { vatRateBasisPoints: 700 },
          {
            mode: 'development',
            allowUnkeyedAudit: true,
            warningLogger: (warning): void => {
              warnings.push(warning);
            },
          },
        ),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it('does not echo personal input values in schema errors', async () => {
    const service = makeService(new MemoryRepository());
    const input = {
      ...baseInput('bad'),
      seller: { name: 'PRIVATE-NAME', address: '', taxId: 'PRIVATE-TAX-ID' },
    };
    let failure: unknown;
    try {
      await service.createDraft(input, issuer);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as Error).message).not.toContain('PRIVATE');
  });
});
