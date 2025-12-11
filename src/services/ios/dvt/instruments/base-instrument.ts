import type { Channel } from '../channel.js';
import type { DVTSecureSocketProxyService } from '../index.js';

/**
 * Base class for DVT instrument services.
 *
 * Subclasses must define a static `IDENTIFIER` property.
 */
export abstract class BaseInstrument {
  static readonly IDENTIFIER: string;

  protected channel: Channel | null = null;
  constructor(protected readonly dvt: DVTSecureSocketProxyService) {}

  protected get identifier(): string {
    return (this.constructor as typeof BaseInstrument).IDENTIFIER;
  }

  /**
   * Initialize the instrument channel.
   */
  async initialize(): Promise<void> {
    if (!this.channel) {
      this.channel = await this.dvt.makeChannel(this.identifier);
    }
  }
}
