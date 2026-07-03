import type {XPCDictionary, XPCValue} from '../types.js';

/**
 * Coerces an XPC value to a dictionary, or `undefined` when it is not a plain
 * object (an array, primitive, `null`, or `undefined`).
 */
export function asDictionary(value: XPCValue | undefined): XPCDictionary | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XPCDictionary) : undefined;
}
