import { logger } from '@appium/support';

import type {
  PlistDictionary,
  PowerAssertionService as PowerAssertionServiceInterface,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('PowerAssertionService');

/**
 * Power assertion types that can be used to prevent system sleep
 */
enum PowerAssertionType {
  WIRELESS_SYNC = 'AMDPowerAssertionTypeWirelessSync',
  PREVENT_USER_IDLE_SYSTEM_SLEEP = 'PreventUserIdleSystemSleep',
  PREVENT_SYSTEM_SLEEP = 'PreventSystemSleep',
}

/**
 * PowerAssertionService provides an API to create power assertions.
 */
class PowerAssertionService
  extends BaseService
  implements PowerAssertionServiceInterface
{
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.assertion_agent.shim.remote';

  private _conn: ServiceConnection | null = null;

  /**
   * Create a power assertion to prevent system sleep
   * @param type The type of power assertion to create
   * @param name A descriptive name for the assertion
   * @param timeout Timeout in seconds for how long the assertion should last
   * @param [details] Additional details about the assertion
   * @returns Promise that resolves when the assertion is created
   */
  async createPowerAssertion(
    type: PowerAssertionType,
    name: string,
    timeout: number,
    details?: string,
  ): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToPowerAssertionService();
    }

    const request = this.buildCreateAssertionRequest(
      type,
      name,
      timeout,
      details,
    );
    await this._conn.sendPlistRequest(request);
    log.info(
      `Power assertion created: type="${type}", name="${name}", timeout=${timeout}s`,
    );
  }

  /**
   * Close the connection to the power assertion service
   */
  async close(): Promise<void> {
    if (this._conn) {
      await this._conn.close();
      this._conn = null;
      log.debug('Power assertion service connection closed');
    }
  }

  private async connectToPowerAssertionService(): Promise<ServiceConnection> {
    const service = {
      serviceName: PowerAssertionService.RSD_SERVICE_NAME,
      port: String(this.address[1]),
    };
    log.debug(
      `Connecting to power assertion service at ${this.address[0]}:${this.address[1]}`,
    );
    return await this.startLockdownService(service);
  }

  private buildCreateAssertionRequest(
    type: string,
    name: string,
    timeout: number,
    details?: string,
  ): PlistDictionary {
    const request: PlistDictionary = {
      CommandKey: 'CommandCreateAssertion',
      AssertionTypeKey: type,
      AssertionNameKey: name,
      AssertionTimeoutKey: timeout,
    };

    if (details !== undefined) {
      request.AssertionDetailKey = details;
    }

    return request;
  }
}

export { PowerAssertionService, PowerAssertionType };
