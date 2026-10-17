import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type AuditHmacKey = string | Uint8Array;

export function hmacSha256(value: string, key: AuditHmacKey): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
