/**
 * Represents a tag position in XML
 */
interface TagPosition {
  start: number;
  end: number;
  isOpening: boolean;
  tagName: string;
}

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
export function hasUnicodeReplacementCharacter(data: string | Buffer): boolean {
  // Convert to string if it's a Buffer
  const strData = ensureString(data);

  // Check for the replacement character
  const hasReplacementChar = strData.includes('�');

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
export function trimBeforeXmlDeclaration(data: string | Buffer): string {
  const strData = ensureString(data);
  const xmlDeclIndex = strData.indexOf('<?xml');

  if (xmlDeclIndex > 0) {
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
 * Removes extra content after the closing plist tag
 *
 * @param data - The data to clean, can be a string or Buffer
 * @returns The cleaned data as a string
 */
export function removeExtraContentAfterPlist(data: string | Buffer): string {
  const strData = ensureString(data);

  // Find the closing plist tag
  const closingPlistIndex = strData.lastIndexOf('</plist>');

  if (closingPlistIndex > 0) {
    // Keep only the content up to and including the closing plist tag
    return strData.substring(0, closingPlistIndex + 8); // 8 is the length of '</plist>'
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

/**
 * Finds XML tags around a specific position
 *
 * @param xmlString - The XML string to search
 * @param position - The position to search around
 * @returns An object with the nearest tags before and after the position
 */
export function findTagsAroundPosition(
  xmlString: string,
  position: number,
): { beforeTag: TagPosition | null; afterTag: TagPosition | null } {
  // Find the nearest tag ending before the position
  const beforeTagEndPos = xmlString.lastIndexOf('>', position);
  let beforeTag: TagPosition | null = null;

  if (beforeTagEndPos >= 0) {
    // Find the start of this tag
    const beforeTagStartPos = xmlString.lastIndexOf('<', beforeTagEndPos);
    if (beforeTagStartPos >= 0) {
      // Extract the tag content
      const tagContent = xmlString.substring(
        beforeTagStartPos + 1,
        beforeTagEndPos,
      );
      const isClosing = tagContent.startsWith('/');
      const tagName = isClosing
        ? tagContent.substring(1).trim().split(/\s+/)[0]
        : tagContent.trim().split(/\s+/)[0];

      beforeTag = {
        start: beforeTagStartPos,
        end: beforeTagEndPos + 1, // Include the '>'
        isOpening: !isClosing,
        tagName,
      };
    }
  }

  // Find the nearest tag starting after the position
  const afterTagStartPos = xmlString.indexOf('<', position);
  let afterTag: TagPosition | null = null;

  if (afterTagStartPos >= 0) {
    // Find the end of this tag
    const afterTagEndPos = xmlString.indexOf('>', afterTagStartPos);
    if (afterTagEndPos >= 0) {
      // Extract the tag content
      const tagContent = xmlString.substring(
        afterTagStartPos + 1,
        afterTagEndPos,
      );
      const isClosing = tagContent.startsWith('/');
      const tagName = isClosing
        ? tagContent.substring(1).trim().split(/\s+/)[0]
        : tagContent.trim().split(/\s+/)[0];

      afterTag = {
        start: afterTagStartPos,
        end: afterTagEndPos + 1, // Include the '>'
        isOpening: !isClosing,
        tagName,
      };
    }
  }

  return { beforeTag, afterTag };
}

/**
 * Intelligently cleans XML with Unicode replacement characters
 *
 * @param xmlString - The XML string to clean
 * @param badCharPos - The position of the replacement character
 * @returns The cleaned XML string
 */
export function cleanXmlWithReplacementChar(
  xmlString: string,
  badCharPos: number,
): string {
  const { beforeTag, afterTag } = findTagsAroundPosition(xmlString, badCharPos);

  // If we have valid tags on both sides
  if (beforeTag && afterTag) {
    // Case 1: If the replacement character is between complete tags,
    // we can safely remove just the content between them
    if (beforeTag.end <= badCharPos && badCharPos < afterTag.start) {
      return (
        xmlString.substring(0, beforeTag.end) +
        xmlString.substring(afterTag.start)
      );
    }

    // Case 2: If the replacement character is inside a tag,
    // we need a more careful approach
    if (beforeTag.start <= badCharPos && badCharPos < beforeTag.end) {
      // The replacement character is in the tag before the position
      // Find the previous complete tag
      const prevCompleteTag = xmlString.lastIndexOf('>', beforeTag.start);
      if (prevCompleteTag >= 0) {
        return (
          xmlString.substring(0, prevCompleteTag + 1) +
          xmlString.substring(afterTag.start)
        );
      }
    }

    // Case 3: If we can't safely clean, fall back to a more aggressive approach
    return (
      xmlString.substring(0, beforeTag.start) +
      xmlString.substring(afterTag.start)
    );
  }

  // If we don't have valid tags on both sides, use the original fallback approach

  // Find the first valid XML tag
  const firstTagIndex = xmlString.indexOf('<?xml');
  if (firstTagIndex > 0) {
    return xmlString.slice(firstTagIndex);
  }

  // If no XML declaration, look for plist tag
  const plistTagIndex = xmlString.indexOf('<plist');
  if (plistTagIndex > 0) {
    return xmlString.slice(plistTagIndex);
  }

  // Last resort: find any tag
  const anyTagIndex = xmlString.indexOf('<');
  if (anyTagIndex > 0) {
    return xmlString.slice(anyTagIndex);
  }

  // If all else fails, return the original string
  return xmlString;
}
