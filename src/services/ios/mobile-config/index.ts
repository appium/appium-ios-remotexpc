import { fs, logger } from '@appium/support';
import path from 'node:path';

import { SUPPORTED_EXTENSIONS } from '../../../lib/plist/constants.js';
import { createPlist, parsePlist } from '../../../lib/plist/index.js';
import {
  type MobileConfigService as MobileConfigServiceInterface,
  type PlistDictionary,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const ERROR_CLOUD_CONFIGURATION_ALREADY_PRESENT = 14002;
const log = logger.getLogger('MobileConfigService');

/**
 * MobileConfigService provides an API to:
 * - Install configuration profiles
 * - Remove configuration profiles
 * - List installed configuration profiles
 */
class MobileConfigService
  extends BaseService
  implements MobileConfigServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.MCInstall.shim.remote';
  private _conn: ServiceConnection | null = null;

  constructor(address: [string, number]) {
    super(address);
  }
  /**
   * Connect to the mobile config service
   * @returns Promise resolving to the ServiceConnection instance
   */
  async connectToMobileConfigService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }

    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  /**
   * Get all profiles of iOS devices
   * @returns {Promise<PlistDictionary>}
   * e.g.
   * {
   *   OrderedIdentifiers: [ '2fac1c2b3d684843189b2981c718b0132854a847a' ],
   *   ProfileManifest: {
   *     '2fac1c2b3d684843189b2981c718b0132854a847a': {
   *       Description: 'Charles Proxy CA (7 Dec 2020, MacBook-Pro.local)',
   *       IsActive: true
   *     }
   *   },
   *   ProfileMetadata: {
   *     '2fac1c2b3d684843189b2981c718b0132854a847a': {
   *       PayloadDisplayName: 'Charles Proxy CA (7 Dec 2020, MacBook-Pro.local)',
   *       PayloadRemovalDisallowed: false,
   *       PayloadUUID: 'B30005CC-BC73-4E42-8545-8DA6C44A8A71',
   *       PayloadVersion: 1
   *     }
   *   },
   *   Status: 'Acknowledged'
   * }
   */
  async getProfileList(): Promise<PlistDictionary> {
    const req = {
      RequestType: 'GetProfileList',
    };

    return this._sendPlistAndReceive(req);
  }

  /**
   * Install profile from path to iOS device
   * The phone must be unlocked before installing the profile
   * @param {String} filePath  must be a certificate file .PEM .CER and more formats
   * e.g: /Downloads/charles-certificate.pem
   */
  async installProfileFromPath(filePath: string): Promise<void> {
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      throw new Error(`Profile filepath does not exist: ${filePath}`);
    }

    const fileExtension = path.extname(filePath).toLowerCase();
    if (
      !fileExtension ||
      !SUPPORTED_EXTENSIONS.includes(fileExtension as any)
    ) {
      throw new Error(
        `Unsupported file format. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      );
    }

    const payload = await fs.readFile(filePath);
    await this.installProfileFromBuffer(payload);
  }

  /**
   * Install profile to iOS device from buffer
   * The phone must be unlocked before installing the profile
   * @param {Buffer} payload  must be a certificate file buffer .PEM .CER and more formats
   */
  async installProfileFromBuffer(payload: Buffer): Promise<void> {
    try {
      const req = {
        RequestType: 'InstallProfile',
        Payload: parsePlist(payload),
      };
      await this._sendPlistAndReceive(req);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to install profile: ${error.message}`);
      }
      throw error;
    }
  }
  /**
   * Remove profile from iOS device
   * @param {String} identifier Query identifier list through getProfileList method
   */
  async removeProfile(identifier: string): Promise<void> {
    const profileList = await this.getProfileList();
    if (!profileList?.ProfileMetadata) {
      return;
    }

    const profileMetadata = profileList.ProfileMetadata as Record<string, any>;
    if (!(identifier in profileMetadata)) {
      // Get available identifiers from OrderedIdentifiers array or ProfileMetadata keys
      let availableIdentifiers: string[];
      if (
        profileList.OrderedIdentifiers &&
        Array.isArray(profileList.OrderedIdentifiers)
      ) {
        availableIdentifiers = profileList.OrderedIdentifiers as string[];
      } else {
        availableIdentifiers = Object.keys(profileMetadata);
      }

      throw new Error(
        `Trying to remove not installed profile: ${identifier}. Expected one of: ${availableIdentifiers.join(', ')}`,
      );
    }

    const meta = profileMetadata[identifier];
    const payloadData = {
      PayloadIdentifier: identifier,
      PayloadType: 'Configuration',
      PayloadUUID: meta.PayloadUUID,
      PayloadVersion: meta.PayloadVersion,
    };

    const req = {
      RequestType: 'RemoveProfile',
      ProfileIdentifier: createPlist(payloadData),
    };

    log.info(req);

    await this._sendPlistAndReceive(req);
  }

  private async _sendPlistAndReceive(
    req: PlistDictionary,
  ): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToMobileConfigService();
    }
    // Ignore first response as it is just status check
    await this._conn.sendAndReceive(req);
    const res = await this._conn.sendAndReceive(req);
    if (res.Status !== 'Acknowledged') {
      const errorCode = (res.ErrorChain as any[])?.[0]?.ErrorCode;
      if (Number.isInteger(errorCode)) {
        if (errorCode === ERROR_CLOUD_CONFIGURATION_ALREADY_PRESENT) {
          throw new Error(
            'A cloud configuration is already present on device. You must first erase the device to install a new configuration.',
          );
        }
      }
      throw new Error(`Invalid response: ${JSON.stringify(res)}`);
    }
    return res;
  }

  private getServiceConfig(): {
    serviceName: string;
    port: string;
  } {
    return {
      serviceName: MobileConfigService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }
}

export { MobileConfigService };
