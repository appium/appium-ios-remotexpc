/**
 * Creates an XML plist string from a JavaScript object
 * @param obj - The JavaScript object to convert
 * @returns - XML plist string
 */
import type { PlistDictionary, PlistValue } from '../types.js';
import { escapeXml } from './utils.js';

export function createPlist(obj: PlistDictionary): string {
  function convert(value: PlistValue): string {
    if (typeof value === 'number') {
      return `<integer>${value}</integer>`;
    }
    if (typeof value === 'boolean') {
      return value ? '<true/>' : '<false/>';
    }
    if (typeof value === 'string') {
      return `<string>${escapeXml(value)}</string>`;
    }
    if (Buffer.isBuffer(value)) {
      const base64Data = value.toString('base64');
      return `<data>${base64Data}</data>`;
    }
    if (Array.isArray(value)) {
      return `<array>${value.map((item) => convert(item)).join('')}</array>`;
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value)
        .map(([k, v]) => `<key>${escapeXml(k)}</key>${convert(v)}`)
        .join('');
      return `<dict>${entries}</dict>`;
    }
    return '<string></string>';
  }

  const body = Object.entries(obj)
    .map(([key, val]) => `<key>${escapeXml(key)}</key>${convert(val)}`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" 
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>${body}</dict>
</plist>`;
}
