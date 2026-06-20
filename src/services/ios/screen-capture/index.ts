import { BaseService } from '../base-service.js';
import { DVTSecureSocketProxyService } from '../dvt/index.js';
import { Screenshot } from '../dvt/instruments/screenshot.js';

export interface CaptureScreenshotOptions {
  /** DVT screenshot captures the primary display; this is returned as metadata only. */
  displayUniqueId?: string | null;
  /** Image format requested from the device. DVT screenshot returns PNG data. */
  requestedFormat?: 'png' | string;
}

export interface CaptureScreenshotResult {
  image: Buffer;
  displayUniqueID?: string | null;
  imageFormat?: string;
  [key: string]: unknown;
}

export class ScreenCaptureService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    DVTSecureSocketProxyService.RSD_SERVICE_NAME;

  private dvtService: DVTSecureSocketProxyService | null = null;
  private screenshot: Screenshot | null = null;

  constructor(udid: string) {
    super(udid);
  }

  /**
   * Capture a screenshot via the DVT Instruments screenshot service.
   */
  async captureScreenshot(
    options: CaptureScreenshotOptions = {},
  ): Promise<CaptureScreenshotResult> {
    if (options.requestedFormat && options.requestedFormat !== 'png') {
      throw new Error('DVT screenshot service only supports PNG output');
    }

    const screenshot = await this.getScreenshotInstrument();
    const image = await screenshot.getScreenshot();
    return {
      image,
      displayUniqueID: options.displayUniqueId ?? null,
      imageFormat: 'png',
    };
  }

  async close(): Promise<void> {
    if (!this.dvtService) {
      return;
    }
    await this.dvtService.close();
    this.dvtService = null;
    this.screenshot = null;
  }

  protected async getScreenshotInstrument(): Promise<Screenshot> {
    if (this.screenshot) {
      return this.screenshot;
    }

    const dvtService = new DVTSecureSocketProxyService(this.udid);
    await dvtService.connect();
    this.dvtService = dvtService;
    this.screenshot = new Screenshot(dvtService);
    return this.screenshot;
  }
}
