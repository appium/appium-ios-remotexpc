import {
  type PlistDictionary,
  type SpringboardService as SpringboardInterface,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

enum InterfaceOrientation {
  PORTRAIT = 1, // 0 degrees (default)
  PORTRAIT_UPSIDE_DOWN = 2, // 180 degrees
  LANDSCAPE = 3, // 90 degrees clockwise
  LANDSCAPE_HOME_TO_LEFT = 4, // 270 degrees clockwise
}

class SpringBoardService extends BaseService implements SpringboardInterface {
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

  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation (maybe?)
   * Uncomment tests when it is fixed
   */
  async setIconState(newState: PlistDictionary[] = []): Promise<void> {
    try {
      const req = {
        command: 'setIconState',
        iconState: newState,
      };

      await this.sendRequestAndReceive(req);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to set icon state: ${error.message}`);
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

  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation
   * Add tests when it is fixed
   */
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

  async getWallpaperPreviewImage(
    wallpaperName: 'homescreen' | 'lockscreen',
  ): Promise<Buffer> {
    try {
      const req = {
        command: 'getWallpaperPreviewImage',
        wallpaperName,
      };
      const res = await this.sendRequestAndReceive(req);
      return res.pngData as Buffer;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to get wallpaper preview image: ${error.message}`,
        );
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
        throw new Error(
          `Failed to get homescreen icon metrics: ${error.message}`,
        );
      }
      throw error;
    }
  }

  async getInterfaceOrientation(): Promise<InterfaceOrientation> {
    try {
      const req = {
        command: 'getInterfaceOrientation',
      };
      const res = await this.sendRequestAndReceive(req);
      return res.interfaceOrientation as InterfaceOrientation;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to get interface orientation: ${error.message}`,
        );
      }
      throw error;
    }
  }
  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation
   * Add tests when it is fixed
   */
  async getWallpaperPNGData(wallpaperName: string): Promise<Buffer> {
    try {
      const req = {
        command: 'getHomeScreenWallpaperPNGData',
        wallpaperName,
      };
      const res = await this.sendRequestAndReceive(req);
      return res.pngData as Buffer;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get wallpaper PNG data: ${error.message}`);
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
    // Skip StartService response
    await this._conn.sendAndReceive(request);
    return await this._conn.sendPlistRequest(request);
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

export { SpringBoardService, InterfaceOrientation };
