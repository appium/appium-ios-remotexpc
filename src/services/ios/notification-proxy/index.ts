import { logger } from '@appium/support';

import type {
  NotificationProxyService as NotificationProxyServiceInterface,
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('NotificationProxyService');

/**
 * NotificationProxyService provides an API to:
 * - Subscribe to notifications
 * - Unsubscribe from notifications
 * - Post notifications
 * - Receive notifications
 */
class NotificationProxyService
  extends BaseService
  implements NotificationProxyServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.notification_proxy.shim.remote';
  private timeout: number;

  private _conn: any = null;

  constructor(address: [string, number], timeout: number = 10000) {
    super(address);
    this.timeout = timeout;
  }


  async connectToNotificationProxyService() {
    if (this._conn) {
      return this._conn;
    }
    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  /**
   * Subscribe to a notification
   * @param notification The notification name to subscribe to
   * @returns Promise that resolves when the subscription request is sent
   */
  async subscribe(notification: string): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    const request: PlistDictionary = {
      Command: 'ObserveNotification',
      Name: notification,
    };
    const response = await this._conn.sendPlistRequest(request, this.timeout);
    if (!response) {
      return {};
    }
    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }
    return response as PlistDictionary;
  }

  async *receiveNotification(): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    while (true) {
      try {
        const notification = await this._conn.receive(120000);
        log.info(`received response: ${JSON.stringify(notification)}`);
        yield notification;
      } catch (error) {
        log.error(`Error receiving notification: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  private getServiceConfig() {
    return {
      serviceName: NotificationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: this.timeout },
    };
  }
}

export { NotificationProxyService };
