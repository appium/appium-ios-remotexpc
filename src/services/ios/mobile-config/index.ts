import { logger } from '@appium/support';
import fs from 'fs/promises';

import { createBinaryPlist, createPlist, parseBinaryPlist, parseXmlPlist } from '../../../lib/plist';
import { type MobileConfigService as MobileConfigServiceInterface, type PlistDictionary } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';
import {jsonStringify} from "@appium/support/build/lib/util";

const ERROR_CLOUD_CONFIGURATION_ALREADY_PRESENT = 14002;
const log = logger.getLogger('MobileConfigService');


class MobileConfigService extends BaseService implements MobileConfigServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.MCInstall.shim.remote';
  private _conn: ServiceConnection | null = null;

  constructor(address: [string, number]) {
    super(address);
  }

  private async _sendPlistAndReceive(req: PlistDictionary): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToMobileConfigService();
    }
    // Ignore first response as it is just status check
    const _ = await this._conn.sendAndReceive(req);
   //console.log(_);
    const res = await this._conn.sendAndReceive(req);
    console.log(req);
    if (res.Status !== 'Acknowledged') {
      const errorChain = res.ErrorChain;
      if (
        errorChain != null &&
        Array.isArray(errorChain) &&
        errorChain.length > 0
      ) {
        const firstError = errorChain[0];
        if (
          typeof firstError === 'object' &&
          firstError !== null &&
          'ErrorCode' in firstError
        ) {
          const errorCode = firstError.ErrorCode;
          if (errorCode === ERROR_CLOUD_CONFIGURATION_ALREADY_PRESENT) {
            throw new Error('A cloud configuration is already present on device. You must first erase the device to install a new configuration.');
          }
        }
      }
      throw new Error(`Invalid response: ${jsonStringify(res)}`);
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

  // eslint-disable-next-line @typescript-eslint/member-ordering
  async connectToMobileConfigService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }

    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering
  async getProfileList(): Promise<PlistDictionary> {
    const req = {
      RequestType: 'GetProfileList',
    };
    if (!this._conn) {
      this._conn = await this.connectToMobileConfigService();
    }
    return this._sendPlistAndReceive(req);
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering
  async installProfile(path: string): Promise<void> {
    const payload = await fs.readFile(path);
    const req = {
      RequestType: 'InstallProfile',
      Payload: parseXmlPlist(payload),
    };
    await this._sendPlistAndReceive(req);
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering
  async removeProfile(identifier: string): Promise<void> {
    const profileList = await this.getProfileList();
    if (!profileList || !profileList.ProfileMetadata) {
      return;
    }

    const profileMetadata = profileList.ProfileMetadata as Record<string, any>;
    if (!(identifier in profileMetadata)) {
      throw new Error(`Trying to remove not installed profile: ${identifier}`);
    }


    const meta = profileMetadata[identifier];
    const payloadData = {
      PayloadIdentifier: identifier,
      PayloadType: 'Configuration',
      PayloadUUID: meta.PayloadUUID,
      PayloadVersion: meta.PayloadVersion,
    };
      if (!this._conn) {
          this._conn = await this.connectToMobileConfigService();
      }

    console.log(parseBinaryPlist(Buffer.from(createPlist(payloadData))));


    const req = {
      RequestType: 'RemoveProfile',
      ProfileIdentifier: Buffer.from(createPlist(payloadData)),
    };

    console.log(await this._sendPlistAndReceive(req));
  }

}

export { MobileConfigService };