import { getLogger } from '../../../../lib/logger.js';
import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('Graphics');

export class Graphics {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.graphics.opengl';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  async initialize(): Promise<void> {
    if (!this.channel) {
      this.channel = await this.dvt.makeChannel(Graphics.IDENTIFIER);
    }
  }

  async start(): Promise<void> {
    await this.initialize();

    const args = new MessageAux().appendObj(0.0);
    await this.channel!.call('startSamplingAtTimeInterval_')(args);
    await this.channel!.receivePlist();
  }

  async stop(): Promise<void> {
    await this.channel!.call('stopSampling')();
  }

  async *messages(): AsyncGenerator<unknown, void, unknown> {
    log.debug('logging started');
    await this.start();

    try {
      while (true) {
        yield await this.channel!.receivePlist();
      }
    } finally {
      log.debug('logging stopped');
      await this.stop();
    }
  }
}
