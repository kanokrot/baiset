import { canonicalJson } from './canonical-json.js';
import { hmacSha256, sha256 } from './crypto.js';
import type { AuditHmacKey } from './crypto.js';
import type { AuditAnchor, AuditEntry, NewAuditEntry } from './model.js';

export function calculateAuditHash(
  entry: Omit<AuditEntry, 'hash'>,
  hmacKey?: AuditHmacKey,
): string {
  const canonicalEntry = canonicalJson(entry);
  return hmacKey === undefined ? sha256(canonicalEntry) : hmacSha256(canonicalEntry, hmacKey);
}

export function createAuditEntry(
  entry: NewAuditEntry,
  index: number,
  previousHash: string | null,
  hmacKey?: AuditHmacKey,
): AuditEntry {
  const partial = {
    id: `audit:${index}`,
    keyId: entry.keyId,
    documentId: entry.documentId,
    actorId: entry.actorId,
    action: entry.action,
    at: entry.at,
    index,
    previousHash,
  };
  return { ...partial, hash: calculateAuditHash(partial, hmacKey) };
}

export function verifyChain(
  entries: readonly AuditEntry[],
  anchor: AuditAnchor,
  keyring?: AuditKeyring,
): boolean {
  if (!Number.isSafeInteger(anchor.entryCount) || anchor.entryCount !== entries.length)
    return false;
  let previousHash: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      !entry ||
      entry.index !== index ||
      entry.id !== `audit:${index}` ||
      entry.previousHash !== previousHash
    )
      return false;
    const hmacKey = entry.keyId === 'unkeyed' ? undefined : resolveKey(keyring, entry.keyId);
    if (entry.keyId !== 'unkeyed' && hmacKey === undefined) return false;
    if (
      calculateAuditHash(
        {
          index: entry.index,
          id: entry.id,
          keyId: entry.keyId,
          documentId: entry.documentId,
          actorId: entry.actorId,
          action: entry.action,
          at: entry.at,
          previousHash: entry.previousHash,
        },
        hmacKey,
      ) !== entry.hash
    )
      return false;
    previousHash = entry.hash;
  }
  return anchor.headHash === previousHash;
}

export type AuditKeyring =
  ReadonlyMap<string, AuditHmacKey> | Readonly<Record<string, AuditHmacKey>>;

function resolveKey(keyring: AuditKeyring | undefined, keyId: string): AuditHmacKey | undefined {
  if (keyring === undefined) return undefined;
  return keyring instanceof Map
    ? keyring.get(keyId)
    : (keyring as Readonly<Record<string, AuditHmacKey>>)[keyId];
}
