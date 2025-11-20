import { getLogger } from '../../../../lib/logger.js';
import type { Channel } from '../channel.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('Screenshot');

/**
 * Screenshot service for capturing device screenshots
 */
export class Screenshot {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.screenshot';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  async initialize(): Promise<void> {
    if (!this.channel) {
      this.channel = await this.dvt.makeChannel(Screenshot.IDENTIFIER);
    }
  }

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
