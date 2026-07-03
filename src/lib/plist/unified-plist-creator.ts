import type {PlistDictionary} from '../types.js';
import {createBinaryPlist} from './binary-plist-creator.js';
import {createPlist as createXmlPlist} from './plist-creator.js';

/**
 * Unified plist creator that can create both XML and binary plists
 * @param obj - The JavaScript object to convert to a plist
 * @param binary - Whether to create a binary plist (true) or XML plist (false)
 * @returns The plist data as a string (XML) or Buffer (binary)
 */
export function createPlist(obj: PlistDictionary, binary: boolean = false): string | Buffer {
  if (binary) {
    return createBinaryPlist(obj);
  }
  return createXmlPlist(obj);
}
