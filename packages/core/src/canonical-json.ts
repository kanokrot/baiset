export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: { [key: string]: JsonValue } = {};
    const originalKeys = Object.keys(record);
    const keyMap = new Map<string, string>();
    for (const originalKey of originalKeys) {
      const key = originalKey.normalize('NFC');
      if (keyMap.has(key)) throw new TypeError('Canonical JSON has equivalent Unicode keys');
      keyMap.set(key, originalKey);
    }
    for (const key of [...keyMap.keys()].sort()) {
      const originalKey = keyMap.get(key);
      if (originalKey === undefined) throw new TypeError('Canonical JSON key normalization failed');
      const item = record[originalKey];
      if (item !== undefined) normalized[key] = normalize(item);
    }
    return normalized;
  }
  throw new TypeError('Canonical JSON supports JSON values only');
}
