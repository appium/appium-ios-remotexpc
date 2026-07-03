import type {XPCDictionary} from '../../../lib/types.js';

export type PasteboardDataInclusionPolicy = XPCDictionary;

export interface PasteboardItem extends XPCDictionary {
  types: string[];
  data: XPCDictionary;
}

export interface PasteboardSnapshot extends XPCDictionary {
  items?: PasteboardItem[];
  metadata?: XPCDictionary;
  sourceMetadata?: XPCDictionary;
}

export interface PasteboardPullReply extends XPCDictionary {
  command?: string;
  pasteboard?: PasteboardSnapshot;
}
