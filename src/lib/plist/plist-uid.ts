import type { IPlistUID } from '../types.js';

/**
 * UID (Unique Identifier) class for plist references
 * Used in NSKeyedArchiver format
 */
export class PlistUID implements IPlistUID {
  constructor(public readonly value: number) {}
}
