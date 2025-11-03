import { logger } from '@appium/support';

import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = logger.getLogger('ConditionInducer');

/**
 * Condition profile information
 */
export interface ConditionProfile {
  identifier: string;
  description?: string;
  [key: string]: any;
}

/**
 * Condition group information
 */
export interface ConditionGroup {
  identifier: string;
  profiles: ConditionProfile[];
  [key: string]: any;
}

/**
 * Condition Inducer service for simulating various device conditions
 * such as network conditions, thermal states, etc.
 */
export class ConditionInducer {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.ConditionInducer';

  private readonly dvt: DVTSecureSocketProxyService;
  private channel: Channel | null = null;

  constructor(dvt: DVTSecureSocketProxyService) {
    this.dvt = dvt;
  }

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

    log.warn(
      'Unexpected response format from availableConditionInducers:',
      result,
    );
    return [];
  }

  /**
   * Set a specific condition profile
   * @param profileIdentifier The identifier of the profile to enable
   * @throws Error if the profile identifier is not found
   */
  async set(profileIdentifier: string): Promise<void> {
    await this.initialize();

    const groups = await this.list();

    // Find the profile in the available groups
    for (const group of groups) {
      const profiles = group.profiles || [];
      for (const profile of profiles) {
        if (profileIdentifier === profile.identifier) {
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
    }

    throw new Error(
      `Invalid profile identifier: ${profileIdentifier}. Use list() to see available profiles.`,
    );
  }

  /**
   * Disable the currently active condition
   */
  async disable(): Promise<void> {
    await this.initialize();

    await this.channel!.call('disableActiveCondition')();
    log.info('Disabled active condition');
  }
}
