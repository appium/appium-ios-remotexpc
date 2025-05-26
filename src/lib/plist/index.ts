// Export all components for easy imports
import { createBinaryPlist } from './binary-plist-creator.js';
import { isBinaryPlist, parseBinaryPlist } from './binary-plist-parser.js';
import {
  APPLE_EPOCH_OFFSET,
  BPLIST_MAGIC_AND_VERSION,
  BPLIST_TYPE,
  UTF8_ENCODING,
} from './constants.js';
import { LengthBasedSplitter } from './length-based-splitter.js';
import { createPlist as createXmlPlist } from './plist-creator.js';
import { PlistServiceDecoder } from './plist-decoder.js';
import { PlistServiceEncoder } from './plist-encoder.js';
import { parsePlist as parseXmlPlist } from './plist-parser.js';
import { PlistService } from './plist-service.js';
import { createPlist } from './unified-plist-creator.js';
import { parsePlist } from './unified-plist-parser.js';
import {
  ensureString,
  escapeXml,
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
  isValidXml,
  isXmlPlistContent,
  trimBeforeXmlDeclaration,
} from './utils.js';

export {
  createPlist,
  createXmlPlist,
  createBinaryPlist,
  LengthBasedSplitter,
  parsePlist,
  parseXmlPlist,
  parseBinaryPlist,
  isBinaryPlist,
  PlistService,
  PlistServiceDecoder,
  PlistServiceEncoder,
  APPLE_EPOCH_OFFSET,
  BPLIST_MAGIC_AND_VERSION,
  BPLIST_TYPE,
  UTF8_ENCODING,
  // Utility functions
  hasUnicodeReplacementCharacter,
  findFirstReplacementCharacter,
  ensureString,
  trimBeforeXmlDeclaration,
  fixMultipleXmlDeclarations,
  isValidXml,
  escapeXml,
  isXmlPlistContent,
};
