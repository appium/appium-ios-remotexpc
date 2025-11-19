import { getLogger } from '../../../lib/logger.js';
import type {
  PlistDictionary,
  PowerAssertionService as PowerAssertionServiceInterface,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = getLogger('PowerAssertionService');

/**
 * Power assertion types that can be used to prevent system sleep
 */
export enum PowerAssertionType {
  WIRELESS_SYNC = 'AMDPowerAssertionTypeWirelessSync',
  PREVENT_USER_IDLE_SYSTEM_SLEEP = 'PreventUserIdleSystemSleep',
  PREVENT_SYSTEM_SLEEP = 'PreventSystemSleep',
}

/**
 * Options for power assertion creation
 */
export interface PowerAssertionOptions {
  type: PowerAssertionType;
  name: string;
  timeout: number; // timeout in seconds
  details?: string;
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
   * @param options Options for creating the power assertion
   * @returns Promise that resolves when the assertion is created
   */
  async createPowerAssertion(options: PowerAssertionOptions): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToPowerAssertionService();
    }

    const request = this.buildCreateAssertionRequest(options);
    await this._conn.sendPlistRequest(request);
    log.info(
      `Power assertion created: type="${options.type}", name="${options.name}", timeout=${options.timeout}s`,
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
      port: this.address[1].toString(),
    };
    log.debug(
      `Connecting to power assertion service at ${this.address[0]}:${this.address[1]}`,
    );
    return await this.startLockdownService(service);
  }

  private buildCreateAssertionRequest(
    options: PowerAssertionOptions,
  ): PlistDictionary {
    const request: PlistDictionary = {
      CommandKey: 'CommandCreateAssertion',
      AssertionTypeKey: options.type,
      AssertionNameKey: options.name,
      AssertionTimeoutKey: options.timeout,
    };

    if (options.details !== undefined) {
      request.AssertionDetailKey = options.details;
    }

    return request;
  }
}

export { PowerAssertionService };
