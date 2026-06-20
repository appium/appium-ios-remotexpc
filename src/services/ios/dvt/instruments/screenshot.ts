import { BaseInstrument } from './base-instrument.js';

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
    return await this.takeScreenshot();
  }

  /**
   * Capture a screenshot using an already initialized channel.
   */
  async takeScreenshot(): Promise<Buffer> {
    const channel = this.requireChannel();

    await channel.call('takeScreenshot')();
    const result = await channel.receivePlist();

    if (!result) {
      throw new Error('Failed to capture screenshot: received null response');
    }

    if (!Buffer.isBuffer(result)) {
      throw new Error(
        `Unexpected response format from getScreenshot: expected Buffer, got ${typeof result}`,
      );
    }

    return result;
  }
}
