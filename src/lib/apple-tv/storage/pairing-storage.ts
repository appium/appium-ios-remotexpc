import { logger } from '@appium/support';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createXmlPlist } from '../../plist/index.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import type { PairingStorageInterface } from './types.js';

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly log = logger.getLogger('PairingStorage');

  constructor(private readonly config: PairingConfig) {}

  save(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey = '',
  ): string {
    try {
      const projectRoot = join(import.meta.dirname, '../../../..');
      const pairingDir = join(projectRoot, this.config.pairingDirectory);

      mkdirSync(pairingDir, { recursive: true });

      const pairingFile = join(pairingDir, `remote_${deviceId}.plist`);
      const plistContent = this.createPlistContent(
        ltpk,
        ltsk,
        remoteUnlockHostKey,
      );

      writeFileSync(pairingFile, plistContent);
      this.log.info(`Pairing record saved to: ${pairingFile}`);

      return pairingFile;
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
