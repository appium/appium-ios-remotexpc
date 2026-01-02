import { createInterface } from 'node:readline';

import { getLogger } from '../../logger.js';
import { PairingError } from '../errors.js';
import { NETWORK_CONSTANTS } from '../network/constants.js';
import type { UserInputInterface } from '../pairing-protocol/types.js';

const log = getLogger('UserInputService');

/** Handles user interaction for PIN input during pairing */
export class UserInputService implements UserInputInterface {
  async promptForPIN(): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let timeoutId: NodeJS.Timeout | null = null;

    try {
      const pin = await new Promise<string>((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new PairingError('PIN input timeout', 'INPUT_TIMEOUT'));
        }, NETWORK_CONSTANTS.PIN_INPUT_TIMEOUT_MS);

        rl.question('Enter PIN from Apple TV screen: ', (answer) => {
          // Clear timeout since we got the PIN
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          resolve(answer);
        });
      });

      const cleanPin = pin.trim();
      if (!/^\d+$/.test(cleanPin)) {
        log.error('Invalid PIN format');
        throw new PairingError('PIN must contain only digits', 'INVALID_PIN');
      }

      log.debug('PIN received successfully');
      return cleanPin;
    } finally {
      // Clean up timeout if error occurred before clearing
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      rl.close();
    }
  }

  async promptForInput(prompt: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const input = await new Promise<string>((resolve) => {
        rl.question(prompt, (answer) => {
          resolve(answer);
        });
      });

      return input.trim();
    } finally {
      rl.close();
    }
  }
}
