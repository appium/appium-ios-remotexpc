import { logger } from '@appium/support';
import { DOMParser, Element, Node } from '@xmldom/xmldom';

import type { PlistArray, PlistDictionary, PlistValue } from '../types.js';
import { PlistService } from './plist-service.js';
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

const errorLog = logger.getLogger('PlistError');

/**
 * Parses an XML plist string into a JavaScript object
 *
 * @param xmlData - XML plist data as string or Buffer
 * @returns Parsed JavaScript object
 */
export function parsePlist(xmlData: string | Buffer): PlistDictionary {
  let xmlStr = ensureString(xmlData);

  xmlStr = trimBeforeXmlDeclaration(xmlStr);

  if (hasUnicodeReplacementCharacter(xmlStr)) {
    const badCharPos = findFirstReplacementCharacter(xmlStr);
    xmlStr = cleanXmlWithReplacementChar(xmlStr, badCharPos);
  }

  if (!isValidXml(xmlStr)) {
    if (PlistService.isVerboseErrorLoggingEnabled()) {
      errorLog.debug(
        `Invalid XML: missing root element - XML content: ${xmlStr.substring(0, 200)}...`,
      );
    }
    throw new Error('Invalid XML: missing root element or malformed XML');
  }

  xmlStr = fixMultipleXmlDeclarations(xmlStr);

  xmlStr = removeExtraContentAfterPlist(xmlStr);

  const parser = new DOMParser({
    errorHandler(level, message) {
      if (level === 'fatalError') {
        throw new Error(`Fatal XML parsing error: ${message}`);
      }
      return true;
    },
  });

  const doc = parser.parseFromString(xmlStr, 'text/xml');

  if (!doc) {
    throw new Error('Invalid XML response');
  }

  const plistElements = doc.getElementsByTagName('plist');
  if (plistElements.length === 0) {
    throw new Error('No plist element found in XML');
  }

  const rootDict = doc.getElementsByTagName('dict')[0];
  if (!rootDict) {
    return {};
  }

  return parseDict(rootDict);

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
        if (!node.textContent) {
          return null;
        }
        try {
          return Buffer.from(node.textContent, 'base64');
        } catch {
          return node.textContent;
        }
      default:
        return node.textContent || null;
    }
  }

  function parseDict(dictNode: Element): PlistDictionary {
    const obj: PlistDictionary = {};
    const keys = dictNode.getElementsByTagName('key');

    for (let i = 0; i < keys.length; i++) {
      const keyName = keys[i].textContent || '';
      let valueNode = keys[i].nextSibling;

      while (valueNode && valueNode.nodeType !== Node.ELEMENT_NODE) {
        valueNode = valueNode.nextSibling;
      }

      if (valueNode) {
        obj[keyName] = parseNode(valueNode as Element);
      }
    }

    return obj;
  }

  function parseArray(arrayNode: Element): PlistArray {
    const result: PlistArray = [];
    let childNode = arrayNode.firstChild;

    while (childNode) {
      if (childNode.nodeType === Node.ELEMENT_NODE) {
        result.push(parseNode(childNode as Element));
      }
      childNode = childNode.nextSibling;
    }

    return result;
  }
}
