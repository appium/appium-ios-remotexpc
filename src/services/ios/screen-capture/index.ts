import { BaseService } from '../base-service.js';
import { DVTSecureSocketProxyService } from '../dvt/index.js';
import { Screenshot } from '../dvt/instruments/screenshot.js';
import {
  type CaptureScreenshotOptions,
  type CaptureScreenshotResult,
  ScreenCaptureStreamer,
  type ScreenCaptureStreamerOptions,
} from './streamer.js';

export class ScreenCaptureService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    DVTSecureSocketProxyService.RSD_SERVICE_NAME;

  private dvtService: DVTSecureSocketProxyService | null = null;
  private screenshot: Screenshot | null = null;
  private activeStreamer: ScreenCaptureStreamer | null = null;

  constructor(udid: string) {
    super(udid);
  }

  /**
   * Capture a screenshot via the DVT Instruments screenshot service.
   */
  async captureScreenshot(
    options: CaptureScreenshotOptions = {},
  ): Promise<CaptureScreenshotResult> {
    const screenshot = await this.getScreenshotInstrument();
    const image = await screenshot.getScreenshot();
    return {
      image,
      displayUniqueID: options.displayUniqueId ?? null,
      imageFormat: 'png',
    };
  }

  createStreamer(options: ScreenCaptureStreamerOptions): ScreenCaptureStreamer {
    if (this.activeStreamer && !this.activeStreamer.isStopped) {
      throw new Error('A screen capture streamer is already active');
    }

    this.activeStreamer = new ScreenCaptureStreamer(
      options,
      async (captureOptions) => await this.captureScreenshot(captureOptions),
      (streamer) => {
        if (this.activeStreamer === streamer) {
          this.activeStreamer = null;
        }
      },
    );
    return this.activeStreamer;
  }

  getActiveStreamer(): ScreenCaptureStreamer | null {
    return this.activeStreamer?.isStopped ? null : this.activeStreamer;
  }

  async close(): Promise<void> {
    this.activeStreamer?.stop();

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

export type {
  CaptureScreenshotOptions,
  CaptureScreenshotResult,
  ScreenCaptureStreamer,
  ScreenCaptureStreamerOptions,
};
