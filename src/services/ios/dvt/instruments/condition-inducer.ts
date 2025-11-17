import { getLogger } from '../../../../lib/logger.js';
import type { ConditionGroup } from '../../../../lib/types.js';
import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('ConditionInducer');

/**
 * Condition Inducer service for simulating various device conditions
 * such as network conditions, thermal states, etc.
 */
export class ConditionInducer {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.ConditionInducer';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  /**
   * Initialize the condition inducer channel
   */
  async initialize(): Promise<void> {
    if (this.channel) {
      return;
    }
    this.channel = await this.dvt.makeChannel(ConditionInducer.IDENTIFIER);
  }

  /**
   * List all available condition inducers and their profiles
   * @returns Array of condition groups with their available profiles
   */
  async list(): Promise<ConditionGroup[]> {
    await this.initialize();

    await this.channel!.call('availableConditionInducers')();
    const result = await this.channel!.receivePlist();

    // Handle different response formats
    if (!result) {
      log.warn(
        'Received null/undefined response from availableConditionInducers',
      );
      return [];
    }

    // If result is already an array, return it
    if (Array.isArray(result)) {
      return result as ConditionGroup[];
    }

    throw new Error(
      `Unexpected response format from availableConditionInducers: ${JSON.stringify(result)}`,
    );
  }

  /**
   * Set a specific condition profile
   * @param profileIdentifier The identifier of the profile to enable
   * @throws Error if the profile identifier is not found
   * @throws Error if a condition is already active
   */
  async set(profileIdentifier: string): Promise<void> {
    await this.initialize();

    const groups = await this.list();

    // Find the profile in the available groups
    for (const group of groups) {
      const profiles = group.profiles || [];
      for (const profile of profiles) {
        if (profileIdentifier !== profile.identifier) {
          continue;
        }

        log.info(
          `Enabling condition: ${profile.description || profile.identifier}`,
        );

        const args = new MessageAux()
          .appendObj(group.identifier)
          .appendObj(profile.identifier);

        await this.channel!.call(
          'enableConditionWithIdentifier_profileIdentifier_',
        )(args);

        // Wait for response which may be a raised NSError
        await this.channel!.receivePlist();

        log.info(
          `Successfully enabled condition profile: ${profileIdentifier}`,
        );
        return;
      }
    }

    const availableProfiles = groups.flatMap((group) =>
      (group.profiles || []).map((p) => p.identifier),
    );

    throw new Error(
      `Invalid profile identifier: ${profileIdentifier}. Available profiles: ${availableProfiles.join(', ')}`,
    );
  }

  /**
   * Disable the currently active condition
   *
   * Note: This method is idempotent - calling it when no condition is active
   * will not throw an error.
   */
  async disable(): Promise<void> {
    await this.initialize();

    await this.channel!.call('disableActiveCondition')();
    const response = await this.channel!.receivePlist();

    // Response can be:
    // - true (successfully disabled condition)
    // - NSError object, when no condition is active
    if (response === true) {
      log.info('Disabled active condition');
    } else if (this.isNSError(response)) {
      log.debug('No active condition to disable');
    } else {
      throw new Error(
        `Unexpected response from disableActiveCondition: ${JSON.stringify(response)}`,
      );
    }
  }

  private isNSError(obj: any): boolean {
    return ['NSCode', 'NSUserInfo', 'NSDomain'].some(
      (prop) => obj?.[prop] !== undefined,
    );
  }
}
