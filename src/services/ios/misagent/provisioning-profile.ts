import { parsePlist } from '../../../lib/plist/index.js';
import { type PlistDictionary } from '../../../lib/types.js';

class ProvisioningProfile {
  buf: Buffer;
  public plist: PlistDictionary;

  constructor(buf: Buffer) {
    this.buf = buf;

    // Find '<?xml' marker and extract everything after it
    const xmlMarker = Buffer.from('<?xml');
    const xmlIndex = buf.indexOf(xmlMarker);

    if (xmlIndex === -1) {
      throw new Error('No XML content found in provisioning profile');
    }

    // Get XML content starting from '<?xml'
    let xml = buf.subarray(buf.indexOf(xmlMarker));

    // Find '</plist>' and extract up to and including it
    const plistEnd = Buffer.from('</plist>');
    const plistIndex = xml.indexOf(plistEnd);

    if (plistIndex === -1) {
      throw new Error('No closing </plist> tag found');
    }

    xml = xml.subarray(0, plistIndex + plistEnd.length);
    this.plist = parsePlist(xml) as PlistDictionary;
  }

  toString(): string {
    return JSON.stringify(this.plist);
  }

  toJSON(): PlistDictionary {
    // Only display the plist content
    return this.plist;
  }
}

export { ProvisioningProfile };
