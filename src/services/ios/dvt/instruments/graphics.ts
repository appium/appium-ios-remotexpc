import { getLogger } from '../../../../lib/logger.js';
import { MessageAux } from '../dtx-message.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('Graphics');

export class Graphics extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.graphics.opengl';

  async start(): Promise<void> {
    await this.initialize();
    const channel = this.requireChannel();

    const args = new MessageAux().appendObj(0.0);
    await channel.call('startSamplingAtTimeInterval_')(args);
    await channel.receivePlist();
  }

  async stop(): Promise<void> {
    const channel = this.requireChannel();
    await channel.call('stopSampling')();
  }

  async *messages(): AsyncGenerator<unknown, void, unknown> {
    log.debug('logging started');
    await this.start();

    try {
      const channel = this.requireChannel();
      while (true) {
        yield await channel.receivePlist();
      }
    } finally {
      log.debug('logging stopped');
      await this.stop();
    }
  }
}
