import { DOMParser, Element, Node } from '@xmldom/xmldom';

import type { PlistArray, PlistDictionary, PlistValue } from '../types.js';
import {
  cleanXmlWithReplacementChar,
  ensureString,
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
  isValidXml,
  removeExtraContentAfterPlist,
  trimBeforeXmlDeclaration,
} from './utils.js';

/**
 * Parses an XML plist string into a JavaScript object
 * @param xmlData - XML plist data as string or Buffer
 * @returns - Parsed JavaScript object
 */
export function parsePlist(xmlData: string | Buffer): PlistDictionary {
  let xmlStr = ensureString(xmlData);

  // Find the XML declaration and trim any preceding content
  xmlStr = trimBeforeXmlDeclaration(xmlStr);

  // Check for Unicode replacement characters which might indicate encoding issues
  if (hasUnicodeReplacementCharacter(xmlStr)) {
    // Ensure xmlStr is a string for string operations
    const xmlString = ensureString(xmlStr);

    // Find the position of the first replacement character
    const badCharPos = findFirstReplacementCharacter(xmlString);

    // Use our improved XML cleaning function
    xmlStr = cleanXmlWithReplacementChar(xmlString, badCharPos);
  }

  // Check if the string is empty or not XML
  if (!isValidXml(xmlStr)) {
    throw new Error('Invalid XML: missing root element');
  }

  // Make sure we only have one XML declaration
  xmlStr = fixMultipleXmlDeclarations(xmlStr);

  // Remove any extra content after the closing plist tag
  xmlStr = removeExtraContentAfterPlist(xmlStr);

  // Create the parser with custom error handler to suppress warnings and errors
  const parser = new DOMParser({
    errorHandler(level, message) {
      // Only throw on fatal errors, suppress warnings and regular errors
      if (level === 'fatalError') {
        throw new Error(`Fatal XML parsing error: ${message}`);
      }
      // Suppress warnings and non-fatal errors
      return true;
    },
  });

  // Parse the XML string
  const doc = parser.parseFromString(ensureString(xmlStr), 'text/xml');

  if (!doc) {
    throw new Error('Invalid XML response');
  }

  // Verify we have a plist element
  const plistElements = doc.getElementsByTagName('plist');
  if (plistElements.length === 0) {
    throw new Error('No plist element found in XML');
  }

  function parseNode(node: Element): PlistValue {
    if (!node) {
      return null;
    }

    switch (node.nodeName) {
      case 'dict':
        return parseDict(node);
      case 'array':
        return parseArray(node);
      case 'string':
        return node.textContent || '';
      case 'integer':
        return parseInt(node.textContent || '0', 10);
      case 'real':
        return parseFloat(node.textContent || '0');
      case 'true':
        return true;
      case 'false':
        return false;
      case 'date':
        return new Date(node.textContent || '');
      case 'data':
        // Convert base64 to Buffer for binary data
        if (node.textContent) {
          try {
            return Buffer.from(node.textContent, 'base64');
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) {
            return node.textContent;
          }
        }
        return null;
      default:
        return node.textContent || null;
    }
  }

  function parseDict(dictNode: Element): PlistDictionary {
    const obj: PlistDictionary = {};
    const keys = dictNode.getElementsByTagName('key');

    for (let i = 0; i < keys.length; i++) {
      const keyName = keys[i].textContent || '';
      let valueNode = keys[i].nextSibling as Node | null;

      // Skip text nodes (whitespace)
      while (valueNode && valueNode.nodeType !== 1) {
        valueNode = valueNode.nextSibling;
      }

      if (valueNode && valueNode.nodeType === 1) {
        obj[keyName] = parseNode(valueNode as Element);
      }
    }

    return obj;
  }

  function parseArray(arrayNode: Element): PlistArray {
    const result: PlistArray = [];
    let childNode = arrayNode.firstChild;

    while (childNode) {
      if (childNode.nodeType === 1) {
        // Element node
        result.push(parseNode(childNode as Element));
      }
      childNode = childNode.nextSibling;
    }

    return result;
  }

  // Find the root dictionary
  const rootDict = doc.getElementsByTagName('dict')[0];
  if (rootDict) {
    return parseDict(rootDict);
  }

  throw new Error('Unable to find root dictionary in plist');
}
