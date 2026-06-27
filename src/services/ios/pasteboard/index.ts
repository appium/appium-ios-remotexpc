import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import { CoreDeviceService } from '../core-device/core-device-service.js';
import {
  GENERAL_PASTEBOARD,
  IMAGE_UTIS,
  PASTEBOARD_COMMAND,
  PASTEBOARD_POLICY,
  PASTEBOARD_UTI,
  TEXT_UTIS,
  URL_UTIS,
} from './constants.js';
import type {
  PasteboardDataInclusionPolicy,
  PasteboardItem,
  PasteboardPullReply,
  PasteboardSnapshot,
} from './types.js';

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
    return PasteboardService.extractString(
      await this.get(pasteboardName),
      TEXT_UTIS,
    );
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

  /**
   * Pull the pasteboard and return the first decodable URL string.
   */
  async getUrl(
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<string | undefined> {
    return PasteboardService.extractString(
      await this.get(pasteboardName),
      URL_UTIS,
    );
  }

  /**
   * Replace the pasteboard with a single URL value.
   */
  async setUrl(
    url: string | URL,
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<void> {
    await this.set(
      [PasteboardService.buildUrlItem(String(url))],
      pasteboardName,
    );
  }

  /**
   * Pull the pasteboard and return the first image payload.
   *
   * Reads image data advertised as PNG, JPEG, TIFF, or generic image UTIs.
   */
  async getImage(
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<Buffer | undefined> {
    return PasteboardService.extractData(
      await this.get(pasteboardName),
      IMAGE_UTIS,
    );
  }

  /**
   * Replace the pasteboard with a PNG image payload.
   *
   * The bytes must be PNG data; the pasteboard item is advertised as
   * `public.png`.
   */
  async setImage(
    image: Buffer | Uint8Array,
    pasteboardName = GENERAL_PASTEBOARD,
  ): Promise<void> {
    await this.set([PasteboardService.buildImageItem(image)], pasteboardName);
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

  private static buildUrlItem(url: string): PasteboardItem {
    const payload = Buffer.from(url, 'utf8');
    return {
      types: [...URL_UTIS],
      data: Object.fromEntries(
        URL_UTIS.map((uti) => [uti, { data: Buffer.from(payload) }]),
      ),
    };
  }

  private static buildImageItem(image: Buffer | Uint8Array): PasteboardItem {
    return {
      types: [PASTEBOARD_UTI.PNG],
      data: {
        [PASTEBOARD_UTI.PNG]: { data: Buffer.from(image) },
      },
    };
  }

  private static extractString(
    snapshotOrReply: XPCDictionary | PasteboardSnapshot | PasteboardPullReply,
    utis: readonly string[],
  ): string | undefined {
    const snapshot = pickSnapshot(snapshotOrReply);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    for (const item of items) {
      const dataMap = asDictionary(item.data);
      for (const uti of utis) {
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

  private static extractData(
    snapshotOrReply: XPCDictionary | PasteboardSnapshot | PasteboardPullReply,
    utis: readonly string[],
  ): Buffer | undefined {
    const snapshot = pickSnapshot(snapshotOrReply);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    for (const item of items) {
      const dataMap = asDictionary(item.data);
      for (const uti of utis) {
        const datum = asDictionary(dataMap[uti]);
        const raw = datum?.data;
        if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
          return Buffer.from(raw);
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
