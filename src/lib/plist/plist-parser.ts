import { DOMParser, Element, Node } from '@xmldom/xmldom';

import type { PlistArray, PlistDictionary, PlistValue } from '../types.js';

/**
 * Parses an XML plist string into a JavaScript object
 * @param xmlData - XML plist data as string or Buffer
 * @returns - Parsed JavaScript object
 */
export function parsePlist(xmlData: string | Buffer): PlistDictionary {
  let xmlStr = xmlData instanceof Buffer ? xmlData.toString('utf8') : xmlData;

  // Find the XML declaration
  const xmlDeclIndex = xmlStr.indexOf('<?xml');
  if (xmlDeclIndex > 0) {
    // There's content before the XML declaration, remove it
    xmlStr = xmlStr.slice(xmlDeclIndex);
  }

  // Check for Unicode replacement characters which might indicate encoding issues
  if (xmlStr.includes('�')) {
    // Find the position of the first replacement character
    const badCharPos = xmlStr.indexOf('�');
    const startPos = Math.max(0, badCharPos - 20);
    const endPos = Math.min(xmlStr.length, badCharPos + 20);
    const problematicSection = xmlStr.slice(startPos, endPos);

    // Remove the replacement character and anything before it if it's at the start
    if (badCharPos < 10) {
      // Use a regex to remove anything before the first '<' character
      const firstTagIndex = xmlStr.indexOf('<');
      if (firstTagIndex > 0) {
        xmlStr = xmlStr.slice(firstTagIndex);
      }
    }
  }

  // Check if the string is empty or not XML
  if (
    !xmlStr ||
    !xmlStr.toString().trim() ||
    !xmlStr.toString().includes('<')
  ) {
    throw new Error('Invalid XML: missing root element');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr.toString(), 'text/xml');

  if (!doc) {
    throw new Error('Invalid XML response');
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

export default parsePlist;
