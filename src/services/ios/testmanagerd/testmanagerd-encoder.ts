import { PlistUID } from '../../../lib/plist/index.js';
import { NSKeyedArchiverEncoder } from '../dvt/nskeyedarchiver-encoder.js';

/**
 * Extended NSKeyedArchiver encoder that handles testmanagerd-specific
 * marker types: NSUUID and XCTCapabilities.
 *
 * Marker objects use a `__type` discriminator field so the encoder can
 * distinguish them from plain dictionaries.
 */
export class TestmanagerdEncoder extends NSKeyedArchiverEncoder {
  protected override archiveObject(value: any): number {
    if (value === null || value === undefined) {
      return 0;
    }

    if (value && typeof value === 'object' && value.__type) {
      switch (value.__type) {
        case 'NSUUID':
          return this.archiveNSUUID(value.uuid);
        case 'XCTCapabilities':
          return this.archiveXCTCapabilities(value.capabilities ?? {});
      }
    }

    return super.archiveObject(value);
  }

  private archiveNSUUID(uuidString: string): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const uuidBytes = Buffer.from(uuidString.replace(/-/g, ''), 'hex');
    const classUid = this.getClassUid('NSUUID', 'NSObject');

    this.objects[index] = {
      'NS.uuidbytes': uuidBytes,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  private archiveXCTCapabilities(capabilities: Record<string, any>): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const dictIndex = this.archiveDictionary(capabilities);
    const classUid = this.getClassUid('XCTCapabilities', 'NSObject');

    this.objects[index] = {
      'capabilities-dictionary': new PlistUID(dictIndex),
      $class: new PlistUID(classUid),
    };

    return index;
  }
}
