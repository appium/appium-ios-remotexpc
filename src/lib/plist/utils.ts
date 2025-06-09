import { UTF8_ENCODING } from './constants.js';

/**
 * Represents a tag position in XML
 */
export interface TagPosition {
  start: number;
  end: number;
  isOpening: boolean;
  tagName: string;
}

/**
 * Represents the result of finding tags around a position
 */
export interface TagsAroundPosition {
  beforeTag: TagPosition | null;
  afterTag: TagPosition | null;
}

/**
 * Ensures data is a string for string operations
 *
 * @param data - The data to convert, can be a string or Buffer
 * @returns The data as a string
 */
export function ensureString(data: string | Buffer): string {
  return typeof data === 'string' ? data : data.toString(UTF8_ENCODING);
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
 * Checks if the provided data contains Unicode replacement characters (�),
 * which might indicate encoding issues.
 *
 * @param data - The data to check, can be a string or Buffer
 * @returns True if replacement characters are found, false otherwise
 */
export function hasUnicodeReplacementCharacter(data: string | Buffer): boolean {
  const strData = ensureString(data);

  return strData.includes('�');
}

/**
 * Finds the XML declaration and trims any preceding content
 *
 * @param data - The data to process, can be a string or Buffer
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
    const firstDeclEnd = strData.indexOf('?>') + 2;
    const restOfXml = strData.substring(firstDeclEnd);
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

  const closingPlistIndex = strData.lastIndexOf('</plist>');

  if (closingPlistIndex > 0) {
    return strData.substring(0, closingPlistIndex + 8);
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
  return Boolean(strData) && Boolean(strData.trim()) && strData.includes('<');
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
      // eslint-disable-next-line quotes -- Prettier uses double quotes here to avoid escaping the single quote character
      case `'`:
        return '&apos;';
      default:
        return c;
    }
  });
}

/**
 * Checks if the data contains XML plist content by detecting XML declaration or plist tags
 *
 * @param data - The data to check, can be a string or Buffer
 * @returns True if the data contains XML plist content, false otherwise
 */
export function isXmlPlistContent(data: string | Buffer): boolean {
  return (
    data.toString(UTF8_ENCODING).includes('<?xml') ||
    data.toString(UTF8_ENCODING).includes('<plist')
  );
}

/**
 * Parses a tag content to extract tag name and determine if it's an opening tag
 *
 * @param tagContent - The content between < and > in an XML tag
 * @returns An object with tag name and whether it's an opening tag
 */
function parseTagContent(tagContent: string): {
  tagName: string;
  isOpening: boolean;
} {
  const isClosing = tagContent.startsWith('/');
  const tagName = isClosing
    ? tagContent.substring(1).trim().split(/\s+/)[0]
    : tagContent.trim().split(/\s+/)[0];

  return {
    tagName,
    isOpening: !isClosing,
  };
}

/**
 * Creates a TagPosition object from tag positions and content
 *
 * @param startPos - Start position of the tag
 * @param endPos - End position of the tag
 * @param tagContent - Content between < and > in the tag
 * @returns A TagPosition object
 */
function createTagPosition(
  startPos: number,
  endPos: number,
  tagContent: string,
): TagPosition {
  const { tagName, isOpening } = parseTagContent(tagContent);

  return {
    start: startPos,
    end: endPos + 1,
    isOpening,
    tagName,
  };
}

/**
 * Finds the tag before a specific position in XML
 *
 * @param xmlString - The XML string to search
 * @param position - The position to search before
 * @returns The tag position or null if not found
 */
function findTagBefore(
  xmlString: string,
  position: number,
): TagPosition | null {
  const tagEndPos = xmlString.lastIndexOf('>', position);
  if (tagEndPos < 0) {
    return null;
  }

  const tagStartPos = xmlString.lastIndexOf('<', tagEndPos);
  if (tagStartPos < 0) {
    return null;
  }

  const tagContent = xmlString.substring(tagStartPos + 1, tagEndPos);
  return createTagPosition(tagStartPos, tagEndPos, tagContent);
}

/**
 * Finds the tag after a specific position in XML
 *
 * @param xmlString - The XML string to search
 * @param position - The position to search after
 * @returns The tag position or null if not found
 */
function findTagAfter(xmlString: string, position: number): TagPosition | null {
  const tagStartPos = xmlString.indexOf('<', position);
  if (tagStartPos < 0) {
    return null;
  }

  const tagEndPos = xmlString.indexOf('>', tagStartPos);
  if (tagEndPos < 0) {
    return null;
  }

  const tagContent = xmlString.substring(tagStartPos + 1, tagEndPos);
  return createTagPosition(tagStartPos, tagEndPos, tagContent);
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
): TagsAroundPosition {
  return {
    beforeTag: findTagBefore(xmlString, position),
    afterTag: findTagAfter(xmlString, position),
  };
}

/**
 * Removes content between two positions in an XML string
 *
 * @param xmlString - The XML string to modify
 * @param startPos - The start position to remove from
 * @param endPos - The end position to remove to
 * @returns The modified XML string
 */
function removeContentBetween(
  xmlString: string,
  startPos: number,
  endPos: number,
): string {
  return xmlString.substring(0, startPos) + xmlString.substring(endPos);
}

/**
 * Handles the case where a replacement character is between complete tags
 *
 * @param xmlString - The XML string to clean
 * @param beforeTag - The tag before the replacement character
 * @param afterTag - The tag after the replacement character
 * @returns The cleaned XML string
 */
function cleanBetweenTags(
  xmlString: string,
  beforeTag: TagPosition,
  afterTag: TagPosition,
): string {
  return removeContentBetween(xmlString, beforeTag.end, afterTag.start);
}

/**
 * Handles the case where a replacement character is inside a tag
 *
 * @param xmlString - The XML string to clean
 * @param beforeTag - The tag containing the replacement character
 * @param afterTag - The tag after the replacement character
 * @returns The cleaned XML string or null if can't be cleaned
 */
function cleanInsideTag(
  xmlString: string,
  beforeTag: TagPosition,
  afterTag: TagPosition,
): string | null {
  const prevCompleteTag = xmlString.lastIndexOf('>', beforeTag.start);
  if (prevCompleteTag < 0) {
    return null;
  }

  return removeContentBetween(xmlString, prevCompleteTag + 1, afterTag.start);
}

/**
 * Fallback cleaning method when tags aren't available on both sides
 *
 * @param xmlString - The XML string to clean
 * @returns The cleaned XML string
 */
function fallbackCleaning(xmlString: string): string {
  const xmlDeclIndex = xmlString.indexOf('<?xml');
  if (xmlDeclIndex > 0) {
    return xmlString.slice(xmlDeclIndex);
  }

  const plistTagIndex = xmlString.indexOf('<plist');
  if (plistTagIndex > 0) {
    return xmlString.slice(plistTagIndex);
  }

  const anyTagIndex = xmlString.indexOf('<');
  if (anyTagIndex > 0) {
    return xmlString.slice(anyTagIndex);
  }

  return xmlString;
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

  if (!beforeTag || !afterTag) {
    return fallbackCleaning(xmlString);
  }

  if (beforeTag.end <= badCharPos && badCharPos < afterTag.start) {
    return cleanBetweenTags(xmlString, beforeTag, afterTag);
  }

  if (beforeTag.start <= badCharPos && badCharPos < beforeTag.end) {
    const cleaned = cleanInsideTag(xmlString, beforeTag, afterTag);
    if (cleaned) {
      return cleaned;
    }
  }

  return removeContentBetween(xmlString, beforeTag.start, afterTag.start);
}
