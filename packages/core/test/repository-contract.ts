import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DocumentService } from '../src/index.js';
import type { Clock, CreateDocumentInput, DocumentRepository } from '../src/index.js';
import { verifyChain } from '../src/audit.js';
import { contentHash } from '../src/crypto.js';

export interface RepositoryContractContext {
  repositories: [DocumentRepository, DocumentRepository];
  cleanup(): Promise<void>;
  assertAuditRowsProtected(): Promise<void>;
  assertSecretNotPersisted(secret: string): Promise<void>;
}

export type RepositoryContractFactory = () => Promise<RepositoryContractContext>;

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-02-03T04:05:06.000Z');
  }
}

export function repositoryContract(name: string, open: RepositoryContractFactory): void {
  describe(`${name} repository contract`, () => {
    it('issues 50 gapless numbers concurrently across multiple connections with one audit chain', async () => {
      const context = await open();
      try {
        const options = {
          clock: new FixedClock(),
          auditHmacKey: 'test-hmac-key-with-at-least-32-bytes',
          auditHmacKeyId: 'contract-test-key',
        };
        const services = context.repositories.map(
          (repository) => new DocumentService(repository, { vatRateBasisPoints: 700 }, options),
        );
        const input = (id: string): CreateDocumentInput => ({
          id,
          type: 'invoice',
          series: 'A',
          currency: 'THB',
          sourceDocumentIds: [],
          seller: { name: 'Seller', address: 'Address', taxId: '123' },
          buyer: { name: 'Buyer', address: 'Address' },
          lineItems: [
            {
              description: 'Work',
              quantityMilli: 1000,
              unitPriceSatang: 100,
              vatTreatment: 'taxable',
            },
          ],
        });
        const maker = { id: 'maker', roles: ['issuer'] as const };
        const checker = { id: 'checker', roles: ['approver'] as const };
        const ids = Array.from({ length: 50 }, (_, index) => `parallel-${index}`);
        await Promise.all(
          ids.map(async (id, index) => {
            const service = services[index % 2]!;
            await service.createDraft(input(id), maker);
            await service.submit(id, maker);
          }),
        );
        const issued = await Promise.all(
          ids.map((id, index) => services[index % 2]!.issue(id, checker)),
        );
        const numbers = issued.map((document) => document.number).sort();
        expect(new Set(numbers).size).toBe(ids.length);
        expect(numbers).toEqual(
          ids.map((_, index) => `A-${String(index + 1).padStart(6, '0')}`).sort(),
        );
        const [entries, anchor] = await Promise.all([
          context.repositories[0].listAudit(),
          context.repositories[0].getAuditAnchor(),
        ]);
        expect(entries).toHaveLength(150);
        expect(
          verifyChain(entries, anchor, {
            'contract-test-key': 'test-hmac-key-with-at-least-32-bytes',
          }),
        ).toBe(true);
      } finally {
        await context.cleanup();
      }
    });

    it('reads issued documents back with a verifiable content hash and integer satang amounts', async () => {
      const context = await open();
      try {
        const service = new DocumentService(
          context.repositories[0],
          { vatRateBasisPoints: 700 },
          {
            clock: new FixedClock(),
            auditHmacKey: 'test-hmac-key-with-at-least-32-bytes',
            auditHmacKeyId: 'contract-test-key',
          },
        );
        const input: CreateDocumentInput = {
          id: 'thai-hash-contract',
          type: 'invoice',
          series: 'A',
          currency: 'THB',
          sourceDocumentIds: [],
          seller: {
            name: '\u0e1c\u0e39\u0e49\u0e02\u0e32\u0e22 \u0e44\u0e17\u0e22',
            address:
              '\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23',
            taxId: '0101234567890',
          },
          buyer: {
            name: '\u0e1c\u0e39\u0e49\u0e0b\u0e37\u0e49\u0e2d \u0e17\u0e14\u0e2a\u0e2d\u0e1a',
            address: '\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e43\u0e2b\u0e21\u0e48',
          },
          lineItems: [
            {
              description:
                '\u0e04\u0e48\u0e32\u0e1a\u0e23\u0e34\u0e01\u0e32\u0e23\u0e23\u0e30\u0e1a\u0e1a\u0e40\u0e2d\u0e01\u0e2a\u0e32\u0e23',
              quantityMilli: 1250,
              unitPriceSatang: 12345,
              vatTreatment: 'taxable',
            },
          ],
        };
        await service.createDraft(input, { id: 'maker', roles: ['issuer'] });
        await service.submit(input.id, { id: 'maker', roles: ['issuer'] });
        const issued = await service.issue(input.id, { id: 'checker', roles: ['approver'] });
        const stored = await context.repositories[1].getDocument(input.id);
        expect(stored).toEqual(issued);
        expect(stored?.seller.name).toBe('\u0e1c\u0e39\u0e49\u0e02\u0e32\u0e22 \u0e44\u0e17\u0e22');
        expect(stored?.lineItems[0]?.unitPriceSatang).toBe(12345);
        expect(Number.isInteger(stored?.lineItems[0]?.unitPriceSatang)).toBe(true);
        expect(stored?.totals.subtotalSatang).toBe(15431);
        const { contentHash: storedHash, ...hashedContent } = stored!;
        expect(storedHash).toBe(contentHash(hashedContent));
      } finally {
        await context.cleanup();
      }
    });

    it('does not consume a number when its transaction fails', async () => {
      const context = await open();
      try {
        const [repositoryA, repositoryB] = context.repositories;
        await expect(
          repositoryA.transaction(async (tx) => {
            expect(await tx.nextDocumentNumber('invoice', 'A')).toBe('A-000001');
            throw new Error('forced rollback');
          }),
        ).rejects.toThrow('forced rollback');
        const next = await repositoryB.transaction((tx) => tx.nextDocumentNumber('invoice', 'A'));
        expect(next).toBe('A-000001');
      } finally {
        await context.cleanup();
      }
    });

    it('keeps concurrent audit appends on one unbroken chain', async () => {
      const context = await open();
      try {
        const entries = Array.from({ length: 20 }, (_, index) => ({
          keyId: 'unkeyed',
          documentId: `audit-doc-${index}`,
          actorId: 'contract',
          action: 'created' as const,
          at: '2026-02-03T04:05:06.000Z',
        }));
        await Promise.all(
          entries.map((entry, index) =>
            context.repositories[index % 2]!.transaction((tx) => tx.appendAudit(entry)),
          ),
        );
        const [allEntries, anchor] = await Promise.all([
          context.repositories[0].listAudit(),
          context.repositories[0].getAuditAnchor(),
        ]);
        expect(verifyChain(allEntries, anchor)).toBe(true);
        expect(allEntries).toHaveLength(entries.length);
      } finally {
        await context.cleanup();
      }
    });

    it('keeps the HMAC secret out of persisted JSON', async () => {
      const context = await open();
      try {
        const service = new DocumentService(
          context.repositories[0],
          { vatRateBasisPoints: 700 },
          {
            clock: new FixedClock(),
            auditHmacKey: 'test-hmac-key-with-at-least-32-bytes',
            auditHmacKeyId: 'contract-test-key',
          },
        );
        await service.createDraft(
          {
            id: randomUUID(),
            type: 'invoice',
            seller: { name: 'Seller', address: 'Address', taxId: '123' },
            buyer: { name: 'Buyer', address: 'Address' },
            lineItems: [
              {
                description: 'Work',
                quantityMilli: 1000,
                unitPriceSatang: 100,
                vatTreatment: 'taxable',
              },
            ],
          },
          { id: 'maker', roles: ['issuer'] },
        );
        await context.assertSecretNotPersisted('test-hmac-key-with-at-least-32-bytes');
      } finally {
        await context.cleanup();
      }
    });

    it('protects audit rows from update and deletion', async () => {
      const context = await open();
      try {
        const service = new DocumentService(
          context.repositories[0],
          { vatRateBasisPoints: 700 },
          {
            clock: new FixedClock(),
            allowUnkeyedAudit: true,
            warningLogger: () => undefined,
          },
        );
        await service.createDraft(
          {
            id: randomUUID(),
            type: 'invoice',
            seller: { name: 'Seller', address: 'Address', taxId: '123' },
            buyer: { name: 'Buyer', address: 'Address' },
            lineItems: [
              {
                description: 'Work',
                quantityMilli: 1000,
                unitPriceSatang: 100,
                vatTreatment: 'taxable',
              },
            ],
          },
          { id: 'maker', roles: ['issuer'] },
        );
        await context.assertAuditRowsProtected();
      } finally {
        await context.cleanup();
      }
    });
  });
}
