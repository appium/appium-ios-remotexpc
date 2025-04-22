import { DOMParser, Element, Node } from '@xmldom/xmldom';

/**
 * Parses an XML plist string into a JavaScript object
 * @param xmlData - XML plist data as string or Buffer
 * @returns - Parsed JavaScript object
 */
export function parsePlist(xmlData: string | Buffer): Record<string, any> {
  const xmlStr = xmlData instanceof Buffer ? xmlData.toString('utf8') : xmlData;
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr.toString(), 'text/xml');

  if (!doc) throw new Error('Invalid XML response');

  function parseNode(node: Element): any {
    if (!node) return null;

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
        return node.textContent; // Might need base64 handling for binary data
      default:
        return node.textContent || null;
    }
  }

  function parseDict(dictNode: Element): Record<string, any> {
    const obj: Record<string, any> = {};
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

  function parseArray(arrayNode: Element): any[] {
    const result: any[] = [];
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
