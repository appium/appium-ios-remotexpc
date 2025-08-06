import { logger } from '@appium/support';

import type {
  NotificationProxyService as NotificationProxyServiceInterface,
  PlistMessage,
} from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('NotificationProxyService');

export class NotificationProxyService
  extends BaseService
  implements NotificationProxyServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.notification_proxy.shim.remote';
  private timeout: number;

  constructor(address: [string, number], timeout: number = 2000) {
    super(address);
    this.timeout = timeout;
  }

  async connectToNotificationProxyService(timeout: number = 2000) {
    const service = this.getServiceConfig(timeout);
    return await this.startLockdownService(service);
  }

  private getServiceConfig(timeout: number) {
    return {
      serviceName: NotificationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: timeout },
    };
  }

  async* receive_notification(): AsyncGenerator<PlistMessage> {
    while (true) {
      try {
        const conn = await this.connectToNotificationProxyService();
        yield await conn.receive();
      } catch (error) {
        log.error(`Error receiving notification: ${(error as Error).message}`);
        throw error;
      }
    }
  }
}
