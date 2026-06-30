import {basename} from 'node:path';

import {BaseItem, strongbox} from '@appium/strongbox';
import {util} from '@appium/support';

import {APPLETV_PAIRING_PREFIX, STRONGBOX_CONTAINER_NAME} from '../../../constants.js';
import {getLogger} from '../../logger.js';
import {createXmlPlist, parseXmlPlist} from '../../plist/index.js';
import {PairingError} from '../errors.js';
import type {PairingConfig} from '../types.js';
import type {PairRecord, PairingStorageInterface} from './types.js';

const log = getLogger('PairingStorage');

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly box;

  constructor(private readonly config: PairingConfig) {
    this.box = strongbox(STRONGBOX_CONTAINER_NAME);
  }

  async save(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey = '',
    remotePairingUdid = '',
  ): Promise<string> {
    try {
      const itemName = `${APPLETV_PAIRING_PREFIX}${deviceId}`;
      const plistContent = this.createPlistContent(ltpk, ltsk, remoteUnlockHostKey, remotePairingUdid);

      const item = await this.box.createItemWithValue(itemName, plistContent);
      const itemPath = item.id;

      log.info(`Pairing record saved to: ${itemPath}`);

      return itemPath;
    } catch (error) {
      log.error('Save pairing record error:', error);
      throw new PairingError('Failed to save pairing record', 'SAVE_ERROR', error);
    }
  }

  async load(deviceId: string): Promise<PairRecord | null> {
    const itemName = `${APPLETV_PAIRING_PREFIX}${deviceId}`;
    const item = new BaseItem(itemName, this.box);
    try {
      const pairingData = await item.read();

      if (!pairingData) {
        log.debug(`No pair record found for device ${deviceId}`);
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

      log.debug(`Loaded pair record for ${deviceId}`);

      return {
        privateKey,
        publicKey,
        remoteUnlockHostKey: (parsed.remote_unlock_host_key as string) || '',
        remotePairingUdid:
          typeof parsed.remote_pairing_udid === 'string' ? parsed.remote_pairing_udid.toUpperCase() : undefined,
      };
    } catch (error) {
      log.error(`Failed to load pair record for ${deviceId}:`, error);
      return null;
    }
  }

  async getAvailableDeviceIds(): Promise<string[]> {
    try {
      const deviceIds = new Set<string>();
      const slugPrefix = this.getStrongboxSlugPrefix();

      for (const item of await this.box.listItems()) {
        for (const itemName of [item.name, basename(item.id)]) {
          if (itemName.startsWith(APPLETV_PAIRING_PREFIX)) {
            deviceIds.add(itemName.slice(APPLETV_PAIRING_PREFIX.length));
          } else if (itemName.startsWith(slugPrefix)) {
            deviceIds.add(itemName.slice(slugPrefix.length));
          }
        }
      }

      log.debug(`Found ${util.pluralize('pair record', deviceIds.size, true)}: ${[...deviceIds].join(', ')}`);
      return [...deviceIds];
    } catch (error) {
      log.debug('Error getting available device IDs:', error);
      return [];
    }
  }

  private createPlistContent(
    publicKey: Buffer,
    privateKey: Buffer,
    remoteUnlockHostKey: string,
    remotePairingUdid: string,
  ): string {
    return createXmlPlist({
      private_key: privateKey,
      public_key: publicKey,
      remote_unlock_host_key: remoteUnlockHostKey,
      remote_pairing_udid: remotePairingUdid.toUpperCase(),
    });
  }

  private getStrongboxSlugPrefix(): string {
    const sentinel = 'x';
    const item = new BaseItem(`${APPLETV_PAIRING_PREFIX}${sentinel}`, this.box);
    return basename(item.id).slice(0, -sentinel.length);
  }
}
