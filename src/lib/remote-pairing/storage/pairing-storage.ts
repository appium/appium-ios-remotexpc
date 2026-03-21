import { BaseItem, strongbox } from '@appium/strongbox';
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  APPLETV_PAIRING_PREFIX,
  REMOTE_PAIRING_PREFIX,
  STRONGBOX_CONTAINER_NAME,
} from '../../../constants.js';
import { getLogger } from '../../logger.js';
import { createXmlPlist, parseXmlPlist } from '../../plist/index.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import type { PairRecord, PairingStorageInterface } from './types.js';

const log = getLogger('PairingStorage');

/** Strongbox item names to try when loading (new prefix first). */
function remotePairingItemNames(deviceId: string): string[] {
  return [
    `${REMOTE_PAIRING_PREFIX}${deviceId}`,
    `${APPLETV_PAIRING_PREFIX}${deviceId}`,
  ];
}

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly box;
  private strongboxDir?: string;

  constructor(private readonly config: PairingConfig) {
    this.box = strongbox(STRONGBOX_CONTAINER_NAME);
  }

  async save(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey = '',
  ): Promise<string> {
    try {
      const itemName = `${REMOTE_PAIRING_PREFIX}${deviceId}`;
      const plistContent = this.createPlistContent(
        ltpk,
        ltsk,
        remoteUnlockHostKey,
      );

      const item = await this.box.createItemWithValue(itemName, plistContent);
      const itemPath = item.id;

      log.info(`Pairing record saved to: ${itemPath}`);

      return itemPath;
    } catch (error) {
      log.error('Save pairing record error:', error);
      throw new PairingError(
        'Failed to save pairing record',
        'SAVE_ERROR',
        error,
      );
    }
  }

  async load(deviceId: string): Promise<PairRecord | null> {
    for (const itemName of remotePairingItemNames(deviceId)) {
      const item = new BaseItem(itemName, this.box);
      try {
        const pairingData = await item.read();

        if (!pairingData) {
          continue;
        }

        const parsed = parseXmlPlist(pairingData);

        if (!parsed.private_key || !parsed.public_key) {
          throw new Error('Could not parse pairing record keys');
        }

        const privateKey = Buffer.isBuffer(parsed.private_key)
          ? parsed.private_key
          : Buffer.from(parsed.private_key as string, 'base64');
        const publicKey = Buffer.isBuffer(parsed.public_key)
          ? parsed.public_key
          : Buffer.from(parsed.public_key as string, 'base64');

        log.debug(`Loaded pair record for ${deviceId} (${itemName})`);

        return {
          privateKey,
          publicKey,
          remoteUnlockHostKey: (parsed.remote_unlock_host_key as string) || '',
        };
      } catch (error) {
        log.debug(`No pair record at ${itemName}:`, error);
      }
    }
    log.debug(`No pair record found for device ${deviceId}`);
    return null;
  }

  /** Returns the strongbox path for an existing record, if any. */
  async getPairingRecordPath(deviceId: string): Promise<string | null> {
    for (const itemName of remotePairingItemNames(deviceId)) {
      const item = new BaseItem(itemName, this.box);
      try {
        const data = await item.read();
        if (data) {
          return item.id;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async getAvailableDeviceIds(): Promise<string[]> {
    try {
      if (!this.strongboxDir) {
        const dummyItem = await this.box.createItem('_temp');
        this.strongboxDir = dirname(dummyItem.id);
        // Clean up the temporary item after extracting the directory path
        await dummyItem.clear();
      }

      const files = await readdir(this.strongboxDir);
      const deviceIds = new Set<string>();
      for (const file of files) {
        if (file.startsWith(REMOTE_PAIRING_PREFIX)) {
          deviceIds.add(file.replace(REMOTE_PAIRING_PREFIX, ''));
        } else if (file.startsWith(APPLETV_PAIRING_PREFIX)) {
          deviceIds.add(file.replace(APPLETV_PAIRING_PREFIX, ''));
        }
      }
      const list = [...deviceIds];

      log.debug(`Found ${list.length} pair record(s): ${list.join(', ')}`);
      return list;
    } catch (error) {
      log.debug('Error getting available device IDs:', error);
      return [];
    }
  }

  private createPlistContent(
    publicKey: Buffer,
    privateKey: Buffer,
    remoteUnlockHostKey: string,
  ): string {
    return createXmlPlist({
      private_key: privateKey,
      public_key: publicKey,
      remote_unlock_host_key: remoteUnlockHostKey,
    });
  }
}
