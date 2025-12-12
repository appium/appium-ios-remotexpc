import { getLogger } from '../../../../lib/logger.js';
import { MessageAux } from '../dtx-message.js';
import { decodeNSKeyedArchiver } from '../nskeyedarchiver-decoder.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('Notifications');

/**
 * Application state notification data structure
 */
export interface ApplicationStateNotificationData {
  /** High-precision Mach absolute time timestamp */
  mach_absolute_time: number | bigint;
  /** Full path to the executable (e.g., '/private/var/containers/Bundle/Application/.../MobileCal.app') */
  execName: string;
  /** Short application name (e.g., 'MobileCal') */
  appName: string;
  /** Process ID of the application */
  pid: number;
  /** Application state: 'Foreground' | 'Background' | 'Suspended' | 'Terminated' */
  state_description: string;
}

/**
 * Memory level notification data structure
 */
export interface MemoryLevelNotificationData {
  /** Memory pressure level code (0=Normal, 1=Warning, 2=Critical, 3=...) */
  code: number;
  /** High-precision Mach absolute time timestamp */
  mach_absolute_time: number | bigint;
  /** NSDate timestamp object with NS.time property */
  timestamp: number;
  /** Process ID (-1 for system-wide notifications) */
  pid: number;
}

/**
 * Application state notification message
 */
export interface ApplicationStateNotification {
  selector: 'applicationStateNotification:';
  data: ApplicationStateNotificationData[];
}

/**
 * Memory level notification message
 */
export interface MemoryLevelNotification {
  selector: 'memoryLevelNotification:';
  data: MemoryLevelNotificationData[];
}

/**
 * Monitor memory and app notification
 *
 * @example
 * ```typescript
 * for await (const msg of notifications.messages()) {
 *   if (!msg) continue;
 *
 *   if (msg.selector === 'applicationStateNotification:') {
 *     const notif = msg.data[0];
 *     console.log(`${notif.appName} is ${notif.state_description}`);
 *   }
 * }
 * ```
 */
export type NotificationMessage =
  | ApplicationStateNotification
  | MemoryLevelNotification;

/**
 * Notifications service for monitoring iOS system events
 *
 * @example
 * ```typescript
 * for await (const msg of dvtService.notifications.messages()) {
 *   if (!msg) continue;
 *
 *   if (msg.selector === 'applicationStateNotification:') {
 *     const app = msg.data[0];
 *     console.log(`${app.appName}: ${app.state_description}`);
 *   }
 * }
 * ```
 */
export class Notifications extends BaseInstrument {
  /** DTX service identifier for mobile notifications */
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.mobilenotifications';

  async start(): Promise<void> {
    await this.initialize();
    const args = new MessageAux().appendObj(true);
    await this.channel!.call('setApplicationStateNotificationsEnabled_')(args);
    await this.channel!.call('setMemoryNotificationsEnabled_')(args);
  }

  async stop(): Promise<void> {
    const args = new MessageAux().appendObj(false);
    await this.channel!.call('setApplicationStateNotificationsEnabled_')(args);
    await this.channel!.call('setMemoryNotificationsEnabled_')(args);
  }

  /**
   * Yields notification messages from the iOS device
   */
  async *messages(): AsyncGenerator<NotificationMessage, void, undefined> {
    log.debug('logging started');
    await this.start();

    try {
      while (true) {
        const [selector, auxiliaries] =
          await this.channel!.receivePlistWithAux();

        // Decode NSKeyedArchiver format in auxiliaries
        const decodedData = auxiliaries.map((aux) => {
          if (
            aux &&
            typeof aux === 'object' &&
            aux.$archiver === 'NSKeyedArchiver'
          ) {
            try {
              return decodeNSKeyedArchiver(aux);
            } catch (error) {
              log.warn('Failed to decode NSKeyedArchiver data:', error);
            }
          }
          return aux;
        });

        yield {
          selector: selector as
            | 'applicationStateNotification:'
            | 'memoryLevelNotification:',
          data: decodedData,
        } as NotificationMessage;
      }
    } finally {
      log.debug('logging stopped');
      await this.stop();
    }
  }
}
