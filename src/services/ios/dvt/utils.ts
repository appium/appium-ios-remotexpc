import type { PlistDictionary } from '../../../lib/types.js';

export function isPlainObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasProperties(obj: any, ...props: string[]): boolean {
  return isPlainObject(obj) ? props.every((prop) => prop in obj) : false;
}

export function isNSKeyedArchiverFormat(data: any): boolean {
  return (
    hasProperties(data, '$objects') &&
    Array.isArray(data.$objects) &&
    data.$objects.length > 0
  );
}

export function isNSDictionaryFormat(obj: any): boolean {
  return hasProperties(obj, 'NS.keys', 'NS.objects');
}

export function hasNSErrorIndicators(obj: any): boolean {
  if (!isPlainObject(obj)) {
    return false;
  }

  const errorProps = ['NSCode', 'NSUserInfo', 'NSDomain'];
  return errorProps.some((prop) => prop in obj);
}

/**
 * Extract $objects array from NSKeyedArchiver format, returns null if invalid
 */
export function extractNSKeyedArchiverObjects(data: any): any[] | null {
  if (!isNSKeyedArchiverFormat(data)) {
    return null;
  }

  const objects = data.$objects;
  return objects.length > 1 ? objects : null;
}

/**
 * Extract NSDictionary from NSKeyedArchiver objects using key/value references
 */
export function extractNSDictionary(
  dictObj: any,
  objects: any[],
): PlistDictionary {
  if (!isNSDictionaryFormat(dictObj)) {
    return {};
  }

  const keysRef = dictObj['NS.keys'];
  const valuesRef = dictObj['NS.objects'];

  if (!Array.isArray(keysRef) || !Array.isArray(valuesRef)) {
    return {};
  }

  const result: PlistDictionary = {};
  for (let i = 0; i < keysRef.length; i++) {
    const key = objects[keysRef[i]];
    const value = objects[valuesRef[i]];
    if (typeof key === 'string') {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract strings from NSKeyedArchiver objects array as dictionary keys
 */
export function extractCapabilityStrings(objects: any[]): PlistDictionary {
  const result: PlistDictionary = {};

  // Start from index 1 because index 0 is always '$null' in NSKeyedArchiver format
  for (let i = 1; i < objects.length; i++) {
    const obj = objects[i];
    if (typeof obj === 'string' && obj !== '$null') {
      result[obj] = true;
    }
  }

  return result;
}
