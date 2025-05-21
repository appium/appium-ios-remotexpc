import { logger } from '@appium/support';

const log = logger.getLogger('Plist');

/**
 * Ensures data is a string for string operations
 *
 * @param data - The data to convert, can be a string or Buffer
 * @returns The data as a string
 */
export function ensureString(data: string | Buffer): string {
  return typeof data === 'string' ? data : data.toString('utf8');
}

/**
 * Checks if the provided data contains Unicode replacement characters (�),
 * which might indicate encoding issues.
 *
 * @param data - The data to check, can be a string or Buffer
 * @param logMessage - Optional custom log message. If not provided, a default message will be used.
 * @returns True if replacement characters are found, false otherwise
 */
export function hasUnicodeReplacementCharacter(
  data: string | Buffer,
  logMessage?: string,
): boolean {
  // Convert to string if it's a Buffer
  const strData = ensureString(data);

  // Check for the replacement character
  const hasReplacementChar = strData.includes('�');

  // Log if replacement characters are found
  if (hasReplacementChar) {
    log.debug(logMessage || 'Unicode replacement character detected in data');
  }

  return hasReplacementChar;
}

/**
 * Finds the position of the first Unicode replacement character in the data.
 *
 * @param data - The data to check, can be a string or Buffer
 * @returns The position of the first replacement character, or -1 if not found
 */
export function findFirstReplacementCharacter(data: string | Buffer): number {
  const strData = ensureString(data);
  return strData.indexOf('�');
}

/**
 * Finds the XML declaration and trims any preceding content
 *
 * @param data - The data to process, can be a string or Buffer
 * @param shouldLog - Whether to log when trimming is performed
 * @returns The trimmed data as a string
 */
export function trimBeforeXmlDeclaration(
  data: string | Buffer,
  shouldLog: boolean = false,
): string {
  const strData = ensureString(data);
  const xmlDeclIndex = strData.indexOf('<?xml');

  if (xmlDeclIndex > 0) {
    // There's content before the XML declaration, remove it
    if (shouldLog) {
      log.debug(
        `Found XML declaration at position ${xmlDeclIndex}, trimming preceding content`,
      );
    }
    return strData.slice(xmlDeclIndex);
  }

  return strData;
}

/**
 * Checks for multiple XML declarations and fixes the data by keeping only the first one
 *
 * @param data - The data to check and fix, can be a string or Buffer
 * @returns The fixed data as a string, or the original data if no fix was needed
 */
export function fixMultipleXmlDeclarations(data: string | Buffer): string {
  const strData = ensureString(data);
  const xmlDeclMatches = strData.match(/(<\?xml[^>]*\?>)/g) || [];
  const xmlDeclCount = xmlDeclMatches.length;

  if (xmlDeclCount > 1) {
    log.debug(`Multiple XML declarations found (${xmlDeclCount}), fixing...`);
    // Keep only the first XML declaration
    const firstDeclEnd = strData.indexOf('?>') + 2;
    const restOfXml = strData.substring(firstDeclEnd);
    // Remove any additional XML declarations
    const cleanedRest = restOfXml.replace(/<\?xml[^>]*\?>/g, '');
    return strData.substring(0, firstDeclEnd) + cleanedRest;
  }

  return strData;
}

/**
 * Checks if the data is valid XML (contains at least one tag)
 *
 * @param data - The data to check, can be a string or Buffer
 * @returns True if the data is valid XML, false otherwise
 */
export function isValidXml(data: string | Buffer): boolean {
  const strData = ensureString(data);
  return !!strData && !!strData.trim() && strData.includes('<');
}

/**
 * Escapes special XML characters in a string
 *
 * @param str - The string to escape
 * @returns The escaped string
 */
export function escapeXml(str: string): string {
  return str.replace(/[<>&"']/g, function (c) {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return c;
    }
  });
}

/**
 * Converts a buffer to a string with optional start and end positions
 *
 * @param buffer - The buffer to convert
 * @param start - The start position (default: 0)
 * @param end - The end position (default: buffer.length)
 * @returns The buffer as a string
 */
export function bufferToString(
  buffer: Buffer,
  start: number = 0,
  end: number = buffer.length,
): string {
  return buffer.toString('utf8', start, end);
}

/**
 * Checks if the data contains XML plist content by detecting XML declaration or plist tags
 *
 * @param data - The data to check, can be a string or Buffer
 * @returns True if the data contains XML plist content, false otherwise
 */
export function isXmlPlistContent(data: string | Buffer): boolean {
  const strData = typeof data === 'string' ? data : bufferToString(data);
  return strData.includes('<?xml') || strData.includes('<plist');
}
