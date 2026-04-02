import crypto from 'node:crypto';

import { getLogger } from '../../../lib/logger.js';
import type { TestmanagerdService } from '../../../lib/types.js';
import * as Services from '../../../services.js';
import { MessageAux } from '../dvt/dtx-message.js';
import {
  extractNSKeyedArchiverObjects,
  hasNSErrorIndicators,
} from '../dvt/utils.js';
import {
  DEFAULT_EXEC_CAPABILITIES,
  SELECTOR,
  TESTMANAGERD_CHANNEL,
} from './xctest-common.js';

const log = getLogger('XCTestAttachment');

const MIN_NSERROR_DESCRIPTION_LEN = 20;

/**
 * IDE-side XCTest attachment management for a device (e.g. delete screen
 * recordings by UUID under testmanagerd's Attachments). Opens a short-lived
 * testmanagerd session; private Apple API.
 */
export class XCTestAttachment {
  private readonly udid: string;

  constructor(udid: string) {
    if (!udid?.trim()) {
      throw new Error('udid is required');
    }
    this.udid = udid;
  }

  /** Device UDID passed to the constructor. */
  get deviceId(): string {
    return this.udid;
  }

  /**
   * Delete attachments by UUID (`_IDE_deleteAttachmentsWithUUIDs:`).
   * Opens testmanagerd, initiates an IDE exec session, sends delete, then closes.
   */
  async delete(uuids: string[]): Promise<unknown> {
    if (!uuids?.length) {
      throw new Error('delete requires at least one UUID');
    }

    const conn = await Services.startTestmanagerdService(this.udid);
    try {
      const channel =
        await conn.testmanagerdService.makeChannel(TESTMANAGERD_CHANNEL);
      const channelCode = channel.getCode();

      const sessionId = crypto.randomUUID();
      const initArgs = new MessageAux();
      initArgs.appendObj({ __type: 'NSUUID', uuid: sessionId });
      initArgs.appendObj({
        __type: 'XCTCapabilities',
        capabilities: DEFAULT_EXEC_CAPABILITIES,
      });

      await conn.testmanagerdService.sendMessage(
        channelCode,
        SELECTOR.initiateSession,
        { args: initArgs },
      );
      const [initResult] =
        await conn.testmanagerdService.recvPlist(channelCode);
      log.debug('Exec session for attachment delete:', initResult);

      return await deleteAttachmentsOnChannel(
        conn.testmanagerdService,
        channelCode,
        uuids,
      );
    } finally {
      try {
        await conn.testmanagerdService.close();
      } catch {
        /* ignore */
      }
      try {
        await conn.remoteXPC.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function throwIfNSErrorReply(result: unknown, context: string): void {
  if (result == null || typeof result !== 'object') {
    return;
  }
  const objects = extractNSKeyedArchiverObjects(result);
  if (objects) {
    const hasErr = objects.some((o) => hasNSErrorIndicators(o));
    if (hasErr) {
      const msg =
        objects.find(
          (o: any) =>
            typeof o === 'string' && o.length > MIN_NSERROR_DESCRIPTION_LEN,
        ) ?? 'NSError from testmanagerd';
      throw new Error(`${context}: ${msg}`);
    }
  }
  if (hasNSErrorIndicators(result)) {
    throw new Error(`${context}: ${JSON.stringify(result)}`);
  }
}

/**
 * Send `_IDE_deleteAttachmentsWithUUIDs:` on an existing testmanagerd channel.
 * Used by {@link XCTestAttachment.delete}.
 */
async function deleteAttachmentsOnChannel(
  connection: TestmanagerdService,
  channelCode: number,
  uuids: string[],
): Promise<unknown> {
  if (!uuids.length) {
    throw new Error('deleteAttachmentsOnChannel requires at least one UUID');
  }

  const args = new MessageAux();
  args.appendObj(
    uuids.map((u) => ({
      __type: 'NSUUID' as const,
      uuid: u,
    })),
  );

  await connection.sendMessage(
    channelCode,
    SELECTOR.deleteAttachmentsWithUUIDs,
    { args, expectsReply: true },
  );

  const [result] = await connection.recvPlist(channelCode);
  throwIfNSErrorReply(result, 'deleteAttachmentsOnChannel');
  return result;
}
