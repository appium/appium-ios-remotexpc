import { getLogger } from '../../../../lib/logger.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('Screenshot');

/**
 * Screenshot service for capturing device screenshots
 */
export class Screenshot extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.screenshot';

  /**
   * Capture a screenshot from the device
   * @returns The screenshot data as a Buffer
   */
  async getScreenshot(): Promise<Buffer> {
    await this.initialize();

    await this.channel!.call('takeScreenshot')();
    const result = await this.channel!.receivePlist();

    if (!result) {
      throw new Error('Failed to capture screenshot: received null response');
    }

    if (!Buffer.isBuffer(result)) {
      throw new Error(
        `Unexpected response format from getScreenshot: expected Buffer, got ${typeof result}`,
      );
    }

    log.info(`Screenshot captured successfully (${result.length} bytes)`);
    return result;
  }
}
