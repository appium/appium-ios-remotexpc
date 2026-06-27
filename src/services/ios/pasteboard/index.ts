import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import { CoreDeviceService } from '../core-device/core-device-service.js';

export const GENERAL_PASTEBOARD = 'general';

export const PASTEBOARD_COMMAND = {
  PULL: 'PULL',
  PULL_REPLY: 'PULL_REPLY',
  SET: 'SET',
  SET_REPLY: 'SET_REPLY',
  DATA: 'DATA',
  PUSH: 'PUSH',
  AUTONOTIFY: 'AUTONOTIFY',
  RESOLVE: 'RESOLVE',
} as const;

export const PASTEBOARD_UTI = {
  UTF8_PLAIN_TEXT: 'public.utf8-plain-text',
  PLAIN_TEXT: 'public.plain-text',
  TEXT: 'public.text',
  URL: 'public.url',
} as const;

export const PASTEBOARD_POLICY = {
  ALL_RESOLVED: { allResolved: {} },
  ALL_PROMISED: { allPromised: {} },
  MATCH_SOURCE: { matchSource: {} },
  PROMISE_SECONDARY: { promiseSecondary: {} },
} as const satisfies Record<string, XPCDictionary>;

const TEXT_UTIS = [
  PASTEBOARD_UTI.UTF8_PLAIN_TEXT,
  PASTEBOARD_UTI.PLAIN_TEXT,
  PASTEBOARD_UTI.TEXT,
] as const;

export type PasteboardDataInclusionPolicy = XPCDictionary;

export interface PasteboardItemData extends XPCDictionary {
  data?: Buffer | Uint8Array | string;
  isPromised?: boolean;
  isAvailable?: boolean;
  size?: number | bigint;
}

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

/**
 * Client for `com.apple.coredevice.pasteboardservice`.
 */
export class PasteboardService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.pasteboardservice';

  /**
   * Build a pasteboard item that carries UTF-8 text under the standard text UTIs.
   */
  static buildTextItem(
    text: string,
    utis: readonly string[] = TEXT_UTIS,
  ): PasteboardItem {
    const payload = Buffer.from(text, 'utf8');
    return {
      types: [...utis],
      data: Object.fromEntries(
        utis.map((uti) => [uti, { data: Buffer.from(payload) }]),
      ),
    };
  }

  /**
   * Build a pasteboard item carrying raw data under one UTI.
   */
  static buildDataItem(
    uti: string,
    data: Buffer | Uint8Array | string,
  ): PasteboardItem {
    return {
      types: [uti],
      data: {
        [uti]: { data: toBuffer(data) },
      },
    };
  }

  /**
   * Extract the first decodable UTF-8 text payload from a pasteboard snapshot or reply.
   */
  static extractText(
    snapshotOrReply: XPCDictionary | PasteboardSnapshot | PasteboardPullReply,
  ): string | undefined {
    const snapshot = pickSnapshot(snapshotOrReply);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    for (const item of items) {
      const dataMap = asDictionary(item.data);
      for (const uti of TEXT_UTIS) {
        const datum = asDictionary(dataMap[uti]);
        const raw = datum?.data;
        if (raw === undefined || raw === null) {
          continue;
        }
        const text = decodeUtf8(raw);
        if (text !== undefined) {
          return text;
        }
      }
    }
    return undefined;
  }

  constructor(udid: string) {
    super(udid, PasteboardService.RSD_SERVICE_NAME);
  }

  /**
   * Pull the current pasteboard contents and return the raw device reply.
   */
  async get(
    pasteboardName = GENERAL_PASTEBOARD,
    dataPolicy: PasteboardDataInclusionPolicy = PASTEBOARD_POLICY.ALL_RESOLVED,
  ): Promise<PasteboardPullReply> {
    return (await this.sendReceive(
      {
        command: PASTEBOARD_COMMAND.PULL,
        pasteboardName,
        dataPolicy,
      },
      { actionIdentifier: PASTEBOARD_COMMAND.PULL },
    )) as PasteboardPullReply;
  }

  /**
   * Pull the pasteboard and return the first decodable UTF-8 text item.
   */
  async getText(
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<string | undefined> {
    return PasteboardService.extractText(await this.get(pasteboardName));
  }

  /**
   * Replace the pasteboard with the provided raw items.
   */
  async set(
    items: PasteboardItem[],
    pasteboardName = GENERAL_PASTEBOARD,
    sourceMetadata?: XPCDictionary,
  ): Promise<XPCDictionary> {
    const request: XPCDictionary = {
      command: PASTEBOARD_COMMAND.SET,
      pasteboardName,
      items,
    };
    if (sourceMetadata !== undefined) {
      request.sourceMetadata = sourceMetadata;
    }
    return await this.sendReceive(request, {
      actionIdentifier: PASTEBOARD_COMMAND.SET,
    });
  }

  /**
   * Replace the pasteboard with a single UTF-8 text item.
   */
  async setText(
    text: string,
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<XPCDictionary> {
    return await this.set(
      [PasteboardService.buildTextItem(text)],
      pasteboardName,
    );
  }
}

function pickSnapshot(
  snapshotOrReply: XPCDictionary | PasteboardSnapshot | PasteboardPullReply,
): PasteboardSnapshot {
  const pasteboard = asDictionary(snapshotOrReply.pasteboard);
  return (pasteboard ?? snapshotOrReply) as PasteboardSnapshot;
}

function asDictionary(value: XPCValue | undefined): XPCDictionary | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as XPCDictionary;
  }
  return undefined;
}

function decodeUtf8(value: XPCValue): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return undefined;
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  return typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : Buffer.from(data);
}

export default PasteboardService;
