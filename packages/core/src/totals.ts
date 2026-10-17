import { Money } from './money.js';
import type { DocumentTotals } from './model.js';
import type { LineItem, VatConfig } from './schemas.js';

export function calculateVat(amount: Money, vatRateBasisPoints: number): Money {
  if (
    !Number.isSafeInteger(vatRateBasisPoints) ||
    vatRateBasisPoints < 0 ||
    vatRateBasisPoints > 10000
  ) {
    throw new RangeError('VAT rate must be basis points between 0 and 10000');
  }
  return amount.multiplyRatio(vatRateBasisPoints, 10000);
}

export function calculateTotals(items: readonly LineItem[], config: VatConfig): DocumentTotals {
  let subtotal = Money.zero();
  let vat = Money.zero();
  for (const item of items) {
    const amount = Money.fromSatang(item.unitPriceSatang).multiplyRatio(item.quantityMilli, 1000);
    subtotal = subtotal.add(amount);
    if (item.vatTreatment === 'taxable')
      vat = vat.add(calculateVat(amount, config.vatRateBasisPoints));
  }
  return {
    subtotalSatang: subtotal.satang,
    vatSatang: vat.satang,
    totalSatang: subtotal.add(vat).satang,
  };
}
