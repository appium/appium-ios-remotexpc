import {getLogger} from '../../../lib/logger.js';
import type {AmfiService as AmfiServiceInterface, PlistDictionary, PlistValue} from '../../../lib/types.js';
import type {ServiceConnection} from '../../../service-connection.js';
import {BaseService} from '../base-service.js';
import {MobileImageMounterService} from '../mobile-image-mounter/index.js';
import {AmfiError, DeviceHasPasscodeSetError} from './errors.js';

const log = getLogger('AmfiService');

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Developer Mode actions understood by `com.apple.amfi.lockdown`
 */
export enum DeveloperModeAction {
  /** Make the Developer Mode toggle visible under Settings > Privacy & Security; leaves the state unchanged */
  REVEAL = 0,
  /** Turn Developer Mode on; the device reboots to apply it */
  ENABLE = 1,
  /** Answer the post-reboot "Turn on Developer Mode?" prompt */
  ACCEPT = 2,
}

/**
 * Daemons spell flags inconsistently: reveal answers `success: true`, enable answers `success: 1`
 * (observed on iOS 26). Accept both, and reject anything that is not a recognisable flag.
 */
function asFlag(value: PlistValue | undefined): boolean | undefined {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return undefined;
}

/**
 * Controls Developer Mode (iOS 16+) through the Apple Mobile File Integrity lockdown shim.
 *
 * Every call opens a fresh checked-in connection, drains the shim's unsolicited
 * `StartService` greeting, sends a single plist request and closes the connection.
 * The AMFI daemon answers `{success: true|1}` or `{Error: '<reason>'}`.
 */
class AmfiService extends BaseService implements AmfiServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.amfi.lockdown.shim.remote';

  private readonly timeout: number;

  /**
   * @param udid Device UDID
   * @param timeout Per-step timeout in milliseconds for connect, greeting and reply
   */
  constructor(udid: string, timeout: number = DEFAULT_TIMEOUT_MS) {
    super(udid);
    this.timeout = timeout;
  }

  /**
   * Read the current Developer Mode state through the mobile image mounter shim.
   * Unlike `MobileImageMounterService.queryDeveloperModeStatus()`, a failed read throws instead of
   * reporting "enabled", so `enableDeveloperMode()` never skips on a transport error.
   */
  async isDeveloperModeEnabled(): Promise<boolean> {
    const response = await this.exchange(MobileImageMounterService.RSD_SERVICE_NAME, {
      Command: 'QueryDeveloperModeStatus',
    });
    this.throwOnError(response, 'QueryDeveloperModeStatus');
    const enabled = asFlag(response.DeveloperModeStatus);
    if (enabled === undefined) {
      throw new AmfiError(`Unexpected QueryDeveloperModeStatus reply: ${JSON.stringify(response)}`);
    }
    return enabled;
  }

  /**
   * Make the Developer Mode toggle visible under Settings > Privacy & Security.
   * Does not change the Developer Mode state.
   */
  async revealDeveloperModeOption(): Promise<void> {
    await this.sendAction(DeveloperModeAction.REVEAL);
    log.info('Developer Mode toggle revealed in Settings');
  }

  /**
   * Turn Developer Mode on. Idempotent: when Developer Mode is already on nothing is sent and the device
   * is left untouched. AMFI itself accepts the action in that state, reboots, and leaves Developer Mode
   * OFF until the prompt is accepted, so the status is always read first.
   *
   * Otherwise the device reboots within seconds, which tears down the tunnel; after it comes back a
   * "Turn on Developer Mode?" alert is shown until `acceptDeveloperModePrompt()` answers it.
   * @throws {DeviceHasPasscodeSetError} when the device has a passcode set
   * @throws {AmfiError} for any other rejection reported by the daemon, or when the status read fails
   */
  async enableDeveloperMode(): Promise<void> {
    if (await this.isDeveloperModeEnabled()) {
      log.info('Developer Mode is already enabled; nothing to do');
      return;
    }
    await this.sendAction(DeveloperModeAction.ENABLE);
    log.info('Developer Mode enable accepted; the device will reboot');
  }

  /**
   * Answer the post-reboot "Turn on Developer Mode?" prompt so the flow can run unattended.
   *
   * Idempotent: when Developer Mode is already on nothing is sent. AMFI rejects action 2 whenever no
   * prompt is pending, with `Device has a passcode set` on a passcode-locked device or the generic
   * `An unknown error has occured` otherwise, so the state is read first. During the real post-reboot
   * window the status still reads off, so the prompt is answered as expected.
   * @throws {AmfiError} with code `An unknown error has occured` when Developer Mode is off and no
   *   prompt is pending on a device without a passcode
   */
  async acceptDeveloperModePrompt(): Promise<void> {
    if (await this.isDeveloperModeEnabled()) {
      log.info('Developer Mode is already enabled; no prompt to accept');
      return;
    }
    await this.sendAction(DeveloperModeAction.ACCEPT);
    log.info('Developer Mode post-reboot prompt accepted');
  }

  /**
   * Send one `{action}` request to the AMFI shim and validate the reply
   */
  private async sendAction(action: DeveloperModeAction): Promise<void> {
    const label = DeveloperModeAction[action];
    const response = await this.exchange(AmfiService.RSD_SERVICE_NAME, {action});
    this.throwOnError(response, label);
    if (asFlag(response.success) !== true) {
      throw new AmfiError(`Developer Mode ${label} did not succeed: ${JSON.stringify(response)}`);
    }
  }

  /**
   * Open a fresh checked-in connection to `serviceName`, send one request and close
   */
  private async exchange(serviceName: string, request: PlistDictionary): Promise<PlistDictionary> {
    const conn = await this.connectToShim(serviceName);
    try {
      return await conn.sendPlistRequest(request, this.timeout);
    } finally {
      conn.close();
    }
  }

  /**
   * Check in to a `.shim.remote` service and drain its `StartService` greeting.
   * A greeting carrying `Error` (e.g. `ServiceProhibited`) is surfaced instead of hanging later.
   */
  private async connectToShim(serviceName: string): Promise<ServiceConnection> {
    const conn = await this.startLockdownService(serviceName, {
      createConnectionTimeout: this.timeout,
    });
    try {
      const greeting = await conn.receive(this.timeout);
      this.throwOnError(greeting, 'StartService');
      if (greeting.Request !== 'StartService') {
        throw new AmfiError(`Expected StartService greeting from ${serviceName}, got: ${JSON.stringify(greeting)}`);
      }
      return conn;
    } catch (error) {
      conn.close();
      throw error;
    }
  }

  private throwOnError(response: PlistDictionary | undefined, context: string): void {
    const error = response?.Error;
    if (error === undefined || error === null) {
      return;
    }
    const code = String(error);
    if (code === DeviceHasPasscodeSetError.CODE) {
      throw new DeviceHasPasscodeSetError();
    }
    throw new AmfiError(`Developer Mode ${context} failed: ${code}`, code);
  }
}

export {AmfiService};
