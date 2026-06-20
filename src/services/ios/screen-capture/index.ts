import type { XPCDictionary } from '../../../lib/types.js';
import { CoreDeviceService } from '../core-device/base.js';

export interface CaptureScreenshotOptions {
  /** Optional display identifier; omitted/null captures the primary display. */
  displayUniqueId?: string | null;
  /** Image format requested from the device. CoreDevice currently supports png. */
  requestedFormat?: 'png' | string;
  /** Response timeout in milliseconds. */
  timeout?: number;
}

export interface CaptureScreenshotResult {
  image: Buffer;
  displayUniqueID?: string | null;
  imageFormat?: string;
  [key: string]: unknown;
}

export class ScreenCaptureService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.coredevice.screencaptureservice';

  constructor(udid: string) {
    super(udid, ScreenCaptureService.RSD_SERVICE_NAME);
  }

  /**
   * Capture a screenshot via com.apple.coredevice.screencaptureservice.
   */
  async captureScreenshot(
    options: CaptureScreenshotOptions = {},
  ): Promise<CaptureScreenshotResult> {
    const output = await this.invoke(
      'com.apple.coredevice.feature.capturescreenshot',
      {
        displayUniqueID: options.displayUniqueId ?? null,
        requestedFormat: options.requestedFormat ?? 'png',
      },
      {
        actionIdentifier: 'com.apple.coredevice.action.capturescreenshot',
        timeout: options.timeout,
      },
    );

    if (!isScreenshotResult(output)) {
      throw new Error(
        `Unexpected screenshot response: ${JSON.stringify(output)}`,
      );
    }

    return output;
  }
}

function isScreenshotResult(value: unknown): value is CaptureScreenshotResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const image = (value as XPCDictionary).image;
  return Buffer.isBuffer(image) || image instanceof Uint8Array;
}
