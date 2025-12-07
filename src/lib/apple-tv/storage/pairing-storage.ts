import { strongbox } from '@appium/strongbox';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { STRONGBOX_CONTAINER_NAME } from '../../../constants.js';
import { getLogger } from '../../logger.js';
import { createXmlPlist, parseXmlPlist } from '../../plist/index.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import type { PairRecord, PairingStorageInterface } from './types.js';

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly log = getLogger('PairingStorage');
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
      const itemName = `appletv_pairing_${deviceId}`;
      const plistContent = this.createPlistContent(
        ltpk,
        ltsk,
        remoteUnlockHostKey,
      );

      const item = await this.box.createItemWithValue(itemName, plistContent);
      const itemPath = item.id;

      this.log.info(`Pairing record saved to: ${itemPath}`);

      return itemPath;
    } catch (error) {
      this.log.error('Save pairing record error:', error);
      throw new PairingError(
        'Failed to save pairing record',
        'SAVE_ERROR',
        error,
      );
    }
  }

  async load(deviceId: string): Promise<PairRecord | null> {
    const itemName = `appletv_pairing_${deviceId}`;

    try {
      let item = this.box.getItem(itemName);

      if (!item) {
        item = await this.box.createItem(itemName);
      }

      const pairingData = await item.read();

      if (!pairingData) {
        this.log.debug(`No pair record found for device ${deviceId}`);
        return null;
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

      this.log.debug(`Loaded pair record for ${deviceId}`);

      return {
        privateKey,
        publicKey,
        remoteUnlockHostKey: (parsed.remote_unlock_host_key as string) || '',
      };
    } catch (error) {
      this.log.error(`Failed to load pair record for ${deviceId}:`, error);
      return null;
    }
  }

  async getAvailableDeviceIds(): Promise<string[]> {
    try {
      if (!this.strongboxDir) {
        const dummyItem = await this.box.createItem('_temp');
        this.strongboxDir = dirname(dummyItem.id);
      }

      const files = await readdir(this.strongboxDir);
      const deviceIds = files
        .filter((file: string) => file.startsWith('appletv_pairing_'))
        .map((file: string) => file.replace('appletv_pairing_', ''));

      this.log.debug(
        `Found ${deviceIds.length} pair record(s): ${deviceIds.join(', ')}`,
      );
      return deviceIds;
    } catch (error) {
      this.log.error('Error getting available device IDs:', error);
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
