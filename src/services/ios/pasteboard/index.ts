import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import { CoreDeviceService } from '../core-device/core-device-service.js';

const GENERAL_PASTEBOARD = 'general';

const PASTEBOARD_COMMAND = {
  PULL: 'PULL',
  PULL_REPLY: 'PULL_REPLY',
  SET: 'SET',
  SET_REPLY: 'SET_REPLY',
  DATA: 'DATA',
  PUSH: 'PUSH',
  AUTONOTIFY: 'AUTONOTIFY',
  RESOLVE: 'RESOLVE',
} as const;

const PASTEBOARD_UTI = {
  UTF8_PLAIN_TEXT: 'public.utf8-plain-text',
  PLAIN_TEXT: 'public.plain-text',
  TEXT: 'public.text',
  URL: 'public.url',
} as const;

const PASTEBOARD_POLICY = {
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

type PasteboardDataInclusionPolicy = XPCDictionary;

interface PasteboardItem extends XPCDictionary {
  types: string[];
  data: XPCDictionary;
}

interface PasteboardSnapshot extends XPCDictionary {
  items?: PasteboardItem[];
  metadata?: XPCDictionary;
  sourceMetadata?: XPCDictionary;
}

interface PasteboardPullReply extends XPCDictionary {
  command?: string;
  pasteboard?: PasteboardSnapshot;
}

/**
 * Client for `com.apple.coredevice.pasteboardservice`.
 */
export class PasteboardService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.pasteboardservice';

  constructor(udid: string) {
    super(udid, PasteboardService.RSD_SERVICE_NAME);
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
   * Replace the pasteboard with a single UTF-8 text item.
   */
  async setText(
    text: string,
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<void> {
    await this.set([PasteboardService.buildTextItem(text)], pasteboardName);
  }

  private static buildTextItem(
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

  private static extractText(
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

  private async get(
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

  private async set(
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

export default PasteboardService;
