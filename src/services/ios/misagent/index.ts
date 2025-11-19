import { fs } from '@appium/support';
import path from 'path';

import {
  type MisagentService as MisagentServiceInterface,
  type PlistDictionary,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';
import { ProvisioningProfile } from './provisioning-profile.js';

class MisagentService extends BaseService implements MisagentServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.misagent.shim.remote';
  private _conn: ServiceConnection | null = null;

  async connectToMisagentService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }

    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  async installProfileFromPath(filePath: string): Promise<void> {
    // Check if file exists
    if (!(await fs.exists(filePath))) {
      throw new Error(`Profile filepath does not exist: ${filePath}`);
    }
    const fileExtension = path.extname(filePath).toLowerCase();
    if (fileExtension !== '.mobileprovision') {
      throw new Error(
        `Invalid file extension: ${fileExtension}. Only .mobileprovision files are supported.`,
      );
    }
    const payload = await fs.readFile(filePath);
    await this.installProfile(payload);
  }

  async installProfile(payload: Buffer): Promise<void> {
    await this.sendRequest(
      {
        MessageType: 'Install',
        Profile: payload,
        ProfileType: 'Provisioning',
      },
      'Failed to install profile',
    );
  }

  async removeProfile(uuid: string): Promise<void> {
    await this.sendRequest(
      {
        MessageType: 'Remove',
        ProfileID: uuid,
        ProfileType: 'Provisioning',
      },
      'Failed to remove profile',
    );
  }

  async fetchAll(): Promise<ProvisioningProfile[]> {
    const response = await this.sendRequest(
      {
        MessageType: 'CopyAll',
        ProfileType: 'Provisioning',
      },
      'Failed to copy all profiles',
    );

    if (!response.Payload || !Array.isArray(response.Payload)) {
      return [];
    }

    return response.Payload.filter((profileData): profileData is Buffer =>
      Buffer.isBuffer(profileData),
    ).map((profileData) => new ProvisioningProfile(profileData));
  }

  private async sendRequest(
    request: any,
    errorMessage: string,
  ): Promise<PlistDictionary> {
    const conn = await this.connectToMisagentService();
    try {
      // Skip StartService response
      await conn.sendPlistRequest(request);
      const res = await conn.sendPlistRequest(request);
      if (res.Status) {
        throw new Error(`Invalid response: ${JSON.stringify(res)}`);
      }
      return res;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`${errorMessage}: ${error.message}`);
      }
      throw error;
    }
  }

  private getServiceConfig(): { serviceName: string; port: string } {
    return {
      serviceName: MisagentService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }
}

export { MisagentService };
