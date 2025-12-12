import { getLogger } from '../../../../lib/logger.js';
import { MessageAux } from '../dtx-message.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('Graphics');

export class Graphics extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.graphics.opengl';

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
