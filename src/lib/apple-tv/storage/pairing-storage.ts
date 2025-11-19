import { strongbox } from '@appium/strongbox';
import { logger } from '@appium/support';

import { STRONGBOX_CONTAINER_NAME } from '../../../constants.js';
import { createXmlPlist } from '../../plist/index.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import type { PairingStorageInterface } from './types.js';

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly log = logger.getLogger('PairingStorage');
  private readonly box;

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
