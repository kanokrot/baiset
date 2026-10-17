export type DomainErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'ILLEGAL_TRANSITION'
  | 'SOURCE_INVALID'
  | 'TAX_INVOICE_INVALID'
  | 'NUMBERING_FAILURE';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
