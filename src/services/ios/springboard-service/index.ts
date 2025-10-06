import { BaseService } from '../base-service.js';
import { ServiceConnection } from '../../../service-connection.js';
import { type PlistDictionary } from '../../../lib/types.js';
import { logger } from '@appium/support';

const log = logger.getLogger('springboard-service');

class SpringBoardService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.springboardservices.shim.remote';
  private _conn: ServiceConnection | null = null;

  constructor(address: [string, number]) {
    super(address);
  }

  async getIconState(): Promise<PlistDictionary> {
    try {
      const req = {
        command: 'getIconState',
        formatVersion: '2',
      };
      return await this.sendRequestAndReceive(req);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get Icon state: ${error.message}`);
      }
      throw error;
    }
  }

  async getIconPNGData(bundleID: string): Promise<Buffer> {
    try {
      const req = {
        command: 'getIconPNGData',
        bundleId: bundleID,
      };
      const res = await this.sendRequestAndReceive(req);
      return res.pngData as Buffer;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get Icon PNG data: ${error.message}`);
      }
      throw error;
    }
  }

  async getWallpaperInfo(wallpaperName: string): Promise<PlistDictionary> {
    try {
      const req = {
        command: 'getWallpaperInfo',
        wallpaperName,
      };
      return await this.sendRequestAndReceive(req);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get wallpaper info: ${error.message}`);
      }
      throw error;
    }
  }

  async getHomescreenIconMetrics(): Promise<PlistDictionary> {
    try {
      const req = {
        command: 'getHomeScreenIconMetrics',
      };
      return await this.sendRequestAndReceive(req);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get homescreen icon metrics: ${error.message}`);
      }
      throw error;
    }
  }

  async connectToSpringboardService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }
    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  private async sendRequestAndReceive(
    request: PlistDictionary,
  ): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToSpringboardService();
    }
    const _ = await this._conn.sendAndReceive(request);
    const response = await this._conn.sendPlistRequest(request);

    console.log(response);

    return response;
  }

  private getServiceConfig(): {
    serviceName: string;
    port: string;
  } {
    return {
      serviceName: SpringBoardService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }
}

export { SpringBoardService };
