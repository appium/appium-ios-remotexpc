import { DOMParser, Element, Node } from '@xmldom/xmldom';
import { logger } from '@appium/support';

import type { PlistArray, PlistDictionary, PlistValue } from '../types.js';

const log = logger.getLogger('Plist');

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
    log.debug('Unicode replacement character detected in XML data');
    
    // Ensure xmlStr is a string for string operations
    const xmlString = typeof xmlStr === 'string' ? xmlStr : xmlStr.toString('utf8');
    
    // Find the position of the first replacement character
    const badCharPos = xmlString.indexOf('�');
    
    // Find the nearest XML tag before and after the bad character
    const prevTagPos = xmlString.lastIndexOf('<', badCharPos);
    const nextTagPos = xmlString.indexOf('<', badCharPos);
    
    if (prevTagPos >= 0 && nextTagPos > prevTagPos) {
      // If we have tags on both sides, we can try to clean up just the problematic section
      const cleanedXml = xmlString.substring(0, prevTagPos) + xmlString.substring(nextTagPos);
      xmlStr = cleanedXml;
    } else {
      // Otherwise, find the first valid XML tag and start from there
      const firstTagIndex = xmlString.indexOf('<?xml');
      if (firstTagIndex > 0) {
        xmlStr = xmlString.slice(firstTagIndex);
      } else {
        // If no XML declaration, look for plist tag
        const plistTagIndex = xmlString.indexOf('<plist');
        if (plistTagIndex > 0) {
          xmlStr = xmlString.slice(plistTagIndex);
        } else {
          // Last resort: find any tag
          const anyTagIndex = xmlString.indexOf('<');
          if (anyTagIndex > 0) {
            xmlStr = xmlString.slice(anyTagIndex);
          }
        }
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

  // Make sure we only have one XML declaration
  const xmlString = typeof xmlStr === 'string' ? xmlStr : xmlStr.toString('utf8');
  const xmlDeclMatches = xmlString.match(/(<\?xml[^>]*\?>)/g) || [];
  const xmlDeclCount = xmlDeclMatches.length;
  
  if (xmlDeclCount > 1) {
    log.debug(`Multiple XML declarations found (${xmlDeclCount}), fixing...`);
    // Keep only the first XML declaration
    const firstDeclEnd = xmlString.indexOf('?>') + 2;
    const restOfXml = xmlString.substring(firstDeclEnd);
    // Remove any additional XML declarations
    const cleanedRest = restOfXml.replace(/<\?xml[^>]*\?>/g, '');
    xmlStr = xmlString.substring(0, firstDeclEnd) + cleanedRest;
  }

  try {
    // Create a custom error handler that logs warnings and errors
    const errorHandler = {
      warning: function(msg: string) { 
        log.debug(`XML parser warning: ${msg}`);
      },
      error: function(msg: string) { 
        log.debug(`XML parser error: ${msg}`);
      },
      fatalError: function(msg: string) {
        throw new Error(`XML parsing fatal error: ${msg}`);
      }
    };
    
    // Create the parser with the error handler
    const parser = new DOMParser();
    
    // Parse the XML string
    const doc = parser.parseFromString(xmlStr.toString(), 'text/xml');

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
  } catch (error) {
    log.error(`Error parsing plist: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export default parsePlist;
