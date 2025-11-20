import { getLogger } from '../../../lib/logger.js';

const log = getLogger('NSKeyedArchiverDecoder');

/**
 * Decode NSKeyedArchiver formatted data into native JavaScript objects
 *
 * NSKeyedArchiver is Apple's serialization format that stores object graphs
 * with references. The format includes:
 * - $version: Archive version (typically 100000)
 * - $archiver: "NSKeyedArchiver"
 * - $top: Root object references
 * - $objects: Array of all objects with cross-references
 */
export class NSKeyedArchiverDecoder {
  private readonly objects: any[];
  private readonly decoded: Map<number, any>;
  private readonly archive: any;

  constructor(data: any) {
    if (!NSKeyedArchiverDecoder.isNSKeyedArchive(data)) {
      throw new Error('Data is not in NSKeyedArchiver format');
    }

    this.archive = data;
    this.objects = data.$objects || [];
    this.decoded = new Map();
  }

  /**
   * Check if data is in NSKeyedArchiver format
   */
  static isNSKeyedArchive(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    return (
      '$archiver' in data &&
      data.$archiver === 'NSKeyedArchiver' &&
      '$objects' in data &&
      Array.isArray(data.$objects)
    );
  }

  /**
   * Decode the entire archive starting from the root
   */
  decode(): any {
    if (!this.objects || this.objects.length === 0) {
      return null;
    }

    // Extract root reference from $top
    let rootIndex: number | null = null;

    if (this.archive.$top && typeof this.archive.$top === 'object') {
      const top = this.archive.$top;
      if ('root' in top) {
        const root = top.root;
        if (typeof root === 'number') {
          rootIndex = root;
        } else if (typeof root === 'object' && root && 'CF$UID' in root) {
          rootIndex = (root as any).CF$UID;
        }
      }
    }

    // If we found the root index, decode it
    if (rootIndex !== null) {
      return this.decodeObject(rootIndex);
    }

    // Fallback: decode first non-null object
    log.warn('Could not find root reference, using fallback');
    return this.decodeObject(1);
  }

  /**
   * Decode an object at a specific index
   */
  private decodeObject(index: number): any {
    if (index < 0 || index >= this.objects.length) {
      return null;
    }

    // Check cache
    if (this.decoded.has(index)) {
      return this.decoded.get(index);
    }

    const obj = this.objects[index];

    // Handle null marker
    if (obj === '$null' || obj === null) {
      return null;
    }

    // Handle primitive types
    if (typeof obj !== 'object') {
      return obj;
    }

    // Handle Buffer/binary data (eg. screenshots)
    if (Buffer.isBuffer(obj)) {
      this.decoded.set(index, obj);
      return obj;
    }

    // Handle UID references
    if ('CF$UID' in obj) {
      return this.decodeObject(obj.CF$UID);
    }

    // Handle NSDictionary (NS.keys + NS.objects) - check this FIRST before NSArray
    if ('NS.keys' in obj && 'NS.objects' in obj) {
      const result = this.decodeDictionary(obj['NS.keys'], obj['NS.objects']);
      this.decoded.set(index, result);
      return result;
    }

    // Handle NSArray (NS.objects only, without NS.keys)
    if ('NS.objects' in obj) {
      const result = this.decodeArray(obj['NS.objects']);
      this.decoded.set(index, result);
      return result;
    }

    // Handle regular objects - just return as-is but resolve references
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$class') {
        continue; // Skip class metadata
      }

      if (typeof value === 'number') {
        // Could be a reference or primitive
        const referenced = this.objects[value];
        if (
          referenced &&
          typeof referenced === 'object' &&
          referenced !== '$null'
        ) {
          result[key] = this.decodeObject(value);
        } else {
          result[key] = value;
        }
      } else if (typeof value === 'object' && value && 'CF$UID' in value) {
        const uid = (value as any).CF$UID;
        if (typeof uid === 'number') {
          result[key] = this.decodeObject(uid);
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }

    this.decoded.set(index, result);
    return result;
  }

  /**
   * Decode an NSArray
   */
  private decodeArray(refs: any): any[] {
    if (!Array.isArray(refs)) {
      return [];
    }

    return refs.map((ref) => {
      if (typeof ref === 'number') {
        return this.decodeObject(ref);
      } else if (typeof ref === 'object' && ref && 'CF$UID' in ref) {
        return this.decodeObject(ref.CF$UID);
      }
      return ref;
    });
  }

  /**
   * Decode an NSDictionary
   */
  private decodeDictionary(keyRefs: any, valueRefs: any): any {
    if (!Array.isArray(keyRefs) || !Array.isArray(valueRefs)) {
      return {};
    }

    const result: any = {};

    for (let i = 0; i < keyRefs.length && i < valueRefs.length; i++) {
      const key = this.decodeObject(keyRefs[i]);
      const value = this.decodeObject(valueRefs[i]);

      if (typeof key === 'string') {
        result[key] = value;
      }
    }

    return result;
  }
}

/**
 * Decode NSKeyedArchiver data or return as-is if not archived
 */
export function decodeNSKeyedArchiver(data: any): any {
  if (!data) {
    return data;
  }

  // Check if this is NSKeyedArchiver format
  if (!NSKeyedArchiverDecoder.isNSKeyedArchive(data)) {
    return data;
  }

  try {
    const decoder = new NSKeyedArchiverDecoder(data);
    return decoder.decode();
  } catch (error) {
    log.warn('Failed to decode NSKeyedArchiver data:', error);
    return data;
  }
}
