import { z } from 'zod';

export const documentTypes = [
  'quotation',
  'purchase_order',
  'invoice',
  'billing_note',
  'tax_invoice',
  'credit_note',
  'debit_note',
] as const;
export const roles = ['issuer', 'approver', 'auditor', 'admin'] as const;
export const vatTreatments = ['taxable', 'exempt', 'out_of_scope'] as const;

const safeText = (max: number): z.ZodString => z.string().trim().min(1).max(max);
export const partySchema = z
  .object({
    name: safeText(200),
    address: safeText(1000),
    taxId: z.string().trim().max(32).optional(),
  })
  .strict();

export const lineItemSchema = z
  .object({
    description: safeText(500),
    quantityMilli: z.number().int().positive().safe(),
    unitPriceSatang: z.number().int().nonnegative().safe(),
    vatTreatment: z.enum(vatTreatments),
  })
  .strict();

export const createDocumentSchema = z
  .object({
    id: safeText(100),
    type: z.enum(documentTypes),
    series: safeText(32).default('A'),
    seller: partySchema.extend({ taxId: safeText(32) }),
    buyer: partySchema,
    lineItems: z.array(lineItemSchema).min(1).max(500),
    currency: z.literal('THB').default('THB'),
    sourceDocumentIds: z.array(safeText(100)).max(100).default([]),
    paymentReference: z.string().trim().max(200).optional(),
  })
  .strict();

export const vatConfigSchema = z
  .object({ vatRateBasisPoints: z.number().int().min(0).max(10000) })
  .strict();
export const actorSchema = z
  .object({ id: safeText(100), roles: z.array(z.enum(roles)).min(1) })
  .strict();
export type DocumentType = (typeof documentTypes)[number];
export type Role = (typeof roles)[number];
export type VatTreatment = (typeof vatTreatments)[number];
export type Party = z.infer<typeof partySchema>;
export type LineItem = z.infer<typeof lineItemSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type VatConfig = z.infer<typeof vatConfigSchema>;
