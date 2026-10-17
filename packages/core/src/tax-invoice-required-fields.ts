import type { BusinessDocument } from './model.js';

// These rules must be verified against rd.go.th before release.
export function validateTaxInvoiceRequiredFields(document: BusinessDocument): string[] {
  if (document.type !== 'tax_invoice') return ['Document is not a tax invoice'];
  const issues: string[] = [];
  if (
    !document.title?.includes('\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35')
  ) {
    issues.push('tax invoice title is required');
  }
  if (!document.seller.name.trim()) issues.push('seller name is required');
  if (!document.seller.address.trim()) issues.push('seller address is required');
  if (!document.seller.taxId?.trim()) issues.push('seller tax ID is required');
  if (!document.buyer.name.trim()) issues.push('buyer name is required');
  if (!document.buyer.address.trim()) issues.push('buyer address is required');
  if (!document.number?.trim()) issues.push('document number is required');
  if (
    document.lineItems.length === 0 ||
    document.lineItems.some(
      (item) =>
        !item.description.trim() ||
        !Number.isSafeInteger(item.unitPriceSatang) ||
        item.unitPriceSatang < 0,
    )
  ) {
    issues.push('item details are required');
  }
  if (!document.issueDate) issues.push('issue date is required');
  if (!Number.isSafeInteger(document.totals.vatSatang)) {
    issues.push('separate VAT value is required');
  }
  return issues;
}
