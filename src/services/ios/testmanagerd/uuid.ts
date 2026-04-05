/**
 * Parse and normalize a UUID string for testmanagerd payloads (NSString lists,
 * NSKeyedArchiver NSUUID). Accepts optional `{…}` braces and dashes; returns
 * lowercase RFC-4122 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 */
export function canonicalizeUuidString(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('UUID must be a non-empty string');
  }
  let s = raw.trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    s = s.slice(1, -1).trim();
  }
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID (expected 32 hex digits): ${raw}`);
  }
  const low = hex.toLowerCase();
  return `${low.slice(0, 8)}-${low.slice(8, 12)}-${low.slice(12, 16)}-${low.slice(16, 20)}-${low.slice(20)}`;
}
