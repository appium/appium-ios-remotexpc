import {util} from '@appium/support';

import type {XPCDictionary, XPCValue} from '../types.js';

/**
 * Coerces an XPC value to a dictionary, or `undefined` when it is not a plain
 * object (an array, primitive, `Buffer`, `Uint8Array`, `Date`, `null`, or
 * `undefined`).
 */
export function asDictionary(value: XPCValue | undefined): XPCDictionary | undefined {
  return util.isPlainObject(value) ? (value as XPCDictionary) : undefined;
}
