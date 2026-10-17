export class Money {
  private constructor(readonly satang: number) {}

  static fromSatang(satang: number): Money {
    if (!Number.isSafeInteger(satang))
      throw new RangeError('Money must be a safe integer number of satang');
    return new Money(satang);
  }

  static zero(): Money {
    return Money.fromSatang(0);
  }

  add(other: Money): Money {
    return Money.fromSatang(this.satang + other.satang);
  }

  subtract(other: Money): Money {
    return Money.fromSatang(this.satang - other.satang);
  }

  multiplyRatio(numerator: number, denominator: number): Money {
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      denominator <= 0
    ) {
      throw new RangeError('Money ratio must use safe integers and a positive denominator');
    }
    const product = BigInt(this.satang) * BigInt(numerator);
    const divisor = BigInt(denominator);
    const sign = product < 0n ? -1n : 1n;
    const absoluteProduct = product < 0n ? -product : product;
    const rounded = sign * ((absoluteProduct + divisor / 2n) / divisor);
    return Money.fromSatang(Number(rounded));
  }
}
