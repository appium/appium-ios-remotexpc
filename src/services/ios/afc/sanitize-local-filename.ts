import os from 'node:os';

/** Fallback when a remote name has no safe local characters after sanitization. */
export const EMPTY_SANITIZED_FILENAME = '_';

const MAX_FILENAME_BYTES = 255;

/** C0 and C1 Unicode control characters. */
// eslint-disable-next-line no-control-regex -- intentional filename sanitization
const CONTROL_RE = /[\x00-\x1f\x80-\x9f]/g;

/** Characters invalid on Windows filenames. */
const WINDOWS_ILLEGAL_RE = /[/?<>\\:*|"]/g;

/** Path separator on Unix-like systems (and macOS). */
const POSIX_PATH_SEP_RE = /\//g;

/** Colon is invalid in macOS / HFS+ / APFS file names. */
const DARWIN_ILLEGAL_RE = /:/g;

/** Unix reserved single-segment names (`.` and `..`). */
const RESERVED_DOTS_RE = /^\.+$/;

/** Windows reserved device names (case-insensitive, optional extension). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Sanitize a single path segment from the device for use on the local filesystem.
 *
 * Rules are chosen from {@link os.platform} at pull time (the host writing files).
 */
export function sanitizeLocalFilename(name: string): string {
  switch (os.platform()) {
    case 'win32':
      return sanitizeForWindows(name);
    case 'darwin':
      return sanitizeForDarwin(name);
    default:
      return sanitizeForPosix(name);
  }
}

/**
 * Insert a unique suffix before the file extension (or at the end when there is none).
 */
export function withUniqueSuffix(filename: string, suffix: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0) {
    return `${filename.slice(0, dot)}_${suffix}${filename.slice(dot)}`;
  }
  return `${filename}_${suffix}`;
}

/** Sanitized name with a disambiguating suffix, still within host filename byte limits. */
export function appendUniqueSuffix(sanitized: string, suffix: string): string {
  const dot = sanitized.lastIndexOf('.');
  const hasExtension = dot > 0;
  const base = hasExtension ? sanitized.slice(0, dot) : sanitized;
  const extension = hasExtension ? sanitized.slice(dot) : '';
  const suffixPart = `_${suffix}`;

  const reservedBytes =
    Buffer.byteLength(suffixPart, 'utf8') +
    Buffer.byteLength(extension, 'utf8');
  const maxBaseBytes = MAX_FILENAME_BYTES - reservedBytes;

  const truncatedBase =
    maxBaseBytes > 0
      ? truncateUtf8Bytes(base, maxBaseBytes)
      : EMPTY_SANITIZED_FILENAME;

  const suffixed = hasExtension
    ? `${truncatedBase || EMPTY_SANITIZED_FILENAME}${suffixPart}${extension}`
    : `${truncatedBase || EMPTY_SANITIZED_FILENAME}${suffixPart}`;

  return finalizeSegment(suffixed);
}

function isHighSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdbff;
}

function isLowSurrogate(codePoint: number): boolean {
  return codePoint >= 0xdc00 && codePoint <= 0xdfff;
}

/**
 * Truncate a string to at most `byteLength` UTF-8 bytes without splitting code points.
 * Ported from truncate-utf8-bytes (dependency of sanitize-filename).
 */
function truncateUtf8Bytes(input: string, byteLength: number): string {
  let curByteLength = 0;

  for (let i = 0; i < input.length; i += 1) {
    const codePoint = input.charCodeAt(i);
    let segment = input.charAt(i);

    if (isHighSurrogate(codePoint) && isLowSurrogate(input.charCodeAt(i + 1))) {
      i += 1;
      segment += input.charAt(i);
    }

    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    curByteLength += segmentBytes;

    if (curByteLength === byteLength) {
      return input.slice(0, i + 1);
    }
    if (curByteLength > byteLength) {
      return input.slice(0, i - segment.length + 1);
    }
  }

  return input;
}

/**
 * Strip trailing spaces and dots (invalid on Windows). Avoids regex backtracking (CWE-1333).
 * Ported from sanitize-filename.
 */
function replaceTrailingDotsAndSpaces(
  input: string,
  replacement: string,
): string {
  let end = input.length;
  while (end > 0 && (input[end - 1] === '.' || input[end - 1] === ' ')) {
    end -= 1;
  }
  return end < input.length ? input.slice(0, end) + replacement : input;
}

function stripWith(input: string, pattern: RegExp, replacement = ''): string {
  return input.replace(pattern, replacement);
}

function finalizeSegment(input: string): string {
  const truncated = truncateUtf8Bytes(input, MAX_FILENAME_BYTES);
  return truncated || EMPTY_SANITIZED_FILENAME;
}

function sanitizeForWindows(name: string): string {
  let sanitized = stripWith(name, WINDOWS_ILLEGAL_RE);
  sanitized = stripWith(sanitized, CONTROL_RE);
  sanitized = stripWith(sanitized, RESERVED_DOTS_RE);
  sanitized = stripWith(sanitized, WINDOWS_RESERVED_RE);
  sanitized = replaceTrailingDotsAndSpaces(sanitized, '');
  return finalizeSegment(sanitized);
}

function sanitizeForDarwin(name: string): string {
  let sanitized = stripWith(name, POSIX_PATH_SEP_RE);
  sanitized = stripWith(sanitized, DARWIN_ILLEGAL_RE);
  sanitized = stripWith(sanitized, CONTROL_RE);
  sanitized = stripWith(sanitized, RESERVED_DOTS_RE);
  return finalizeSegment(sanitized);
}

function sanitizeForPosix(name: string): string {
  let sanitized = stripWith(name, POSIX_PATH_SEP_RE);
  sanitized = stripWith(sanitized, CONTROL_RE);
  sanitized = stripWith(sanitized, RESERVED_DOTS_RE);
  return finalizeSegment(sanitized);
}
