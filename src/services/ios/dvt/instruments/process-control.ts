import { getLogger } from '../../../../lib/logger.js';
import { MessageAux } from '../dtx-message.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('ProcessControl');

/**
 * Options for launching a process
 */
export interface ProcessLaunchOptions {
  /** The bundle identifier of the app to launch */
  bundleId: string;
  /** Command line arguments to pass to the process */
  arguments?: string[];
  /** Environment variables to set for the process */
  environment?: Record<string, string>;
  /** Whether to kill an existing instance of the process */
  killExisting?: boolean;
  /** Whether to start the process in a suspended state */
  startSuspended?: boolean;
  /** Additional options to pass to the launch command */
  extraOptions?: Record<string, any>;
}

/**
 * Event received from a running process
 */
export interface OutputReceivedEvent {
  /** The process identifier */
  pid: number;
  /** The output message content */
  message: string;
  /** Timestamp of the event (Mach absolute time) */
  timestamp?: bigint;
  /** Parsed Date object if timestamp is available */
  date?: Date;
}

/**
 * ProcessControl service for managing processes on the device.
 * Allows launching, killing, signaling, and monitoring processes.
 */
export class ProcessControl extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.processcontrol';

  /**
   * Send a signal to a process
   * @param pid The process identifier
   * @param sig The signal number to send
   * @returns The response from the device
   */
  async signal(pid: number, sig: number): Promise<any> {
    await this.initialize();

    // Note: Arguments are swapped in the selector compared to typical kill(pid, sig)
    // selector: signal:toPid:
    const args = new MessageAux().appendInt(sig).appendInt(pid);

    await this.channel!.call('sendSignal_toPid_')(args);
    const result = await this.channel!.receivePlist();

    log.debug(`Sent signal ${sig} to PID ${pid}`);
    return result;
  }

  /**
   * Terminate a process
   * @param pid The process identifier to kill
   */
  async kill(pid: number): Promise<void> {
    await this.initialize();

    const args = new MessageAux().appendObj(pid);

    // killPid: does not expect a reply (fire-and-forget)
    await this.channel!.call('killPid_')(args, false);

    log.info(`Killed PID ${pid}`);
  }

  /**
   * Disable memory limits for a specific process
   * @param pid The process identifier
   * @throws Error if the operation fails
   */
  async disableMemoryLimitForPid(pid: number): Promise<void> {
    await this.initialize();

    const args = new MessageAux().appendInt(pid);

    await this.channel!.call('requestDisableMemoryLimitsForPid_')(args);
    const result = await this.channel!.receivePlist();

    if (!result) {
      throw new Error(`Failed to disable memory limit for PID ${pid}`);
    }

    log.debug(`Disabled memory limit for PID ${pid}`);
  }

  /**
   * Get the process identifier for a bundle identifier
   * @param bundleId The bundle identifier
   * @returns The process identifier (PID)
   */
  async processIdentifierForBundleIdentifier(
    bundleId: string,
  ): Promise<number> {
    await this.initialize();

    const args = new MessageAux().appendObj(bundleId);

    await this.channel!.call('processIdentifierForBundleIdentifier_')(args);
    const result = await this.channel!.receivePlist();

    if (typeof result !== 'number') {
      throw new Error(
        `Invalid response for processIdentifierForBundleIdentifier: ${result}`,
      );
    }

    return result;
  }

  /**
   * Launch a process with the specified options
   * @param options Launch configuration options
   * @returns The process identifier (PID) of the launched process
   */
  async launch(options: ProcessLaunchOptions): Promise<number> {
    await this.initialize();

    const launchOptions: Record<string, any> = {
      StartSuspendedKey: options.startSuspended ?? false,
      KillExisting: options.killExisting ?? true,
      ...options.extraOptions,
    };

    const args = new MessageAux()
      .appendObj('') // Device path (empty)
      .appendObj(options.bundleId)
      .appendObj(options.environment ?? {})
      .appendObj(options.arguments ?? [])
      .appendObj(launchOptions);

    await this.channel!.call(
      'launchSuspendedProcessWithDevicePath_bundleIdentifier_environment_arguments_options_',
    )(args);

    const result = await this.channel!.receivePlist();

    if (typeof result !== 'number') {
      throw new Error(`Failed to launch process: ${JSON.stringify(result)}`);
    }

    log.info(`Launched ${options.bundleId} (PID: ${result})`);
    return result;
  }

  /**
   * Monitor output events from running processes
   * @yields OutputReceivedEvent
   * Note: Unlike other instruments, ProcessControl doesn't require explicit start/stop
   * since output events are passively received without needing to enable monitoring.
   */
  async *outputEvents(): AsyncGenerator<OutputReceivedEvent, void, unknown> {
    await this.initialize();

    // Listen for output events (loop exits on channel error/close)
    while (true) {
      try {
        const [selector, auxiliaries] =
          await this.channel!.receivePlistWithAux();

        if (selector === 'outputReceived:fromProcess:atTime:') {
          // Auxiliaries format: [message (string), pid (int), timestamp (obj/long)]

          if (auxiliaries && auxiliaries.length >= 2) {
            const message = auxiliaries[0];
            const pid = auxiliaries[1];
            const timestampRaw = auxiliaries[2];

            let timestamp: bigint | undefined;
            let date: Date | undefined;

            // Handle timestamp parsing (Mach absolute time format)
            if (typeof timestampRaw === 'bigint') {
              timestamp = timestampRaw;
            } else if (typeof timestampRaw === 'number') {
              timestamp = BigInt(timestampRaw);
            } else if (
              timestampRaw &&
              typeof timestampRaw === 'object' &&
              'NS.time' in timestampRaw
            ) {
              // Handle NSDate object with NS.time property
              timestamp = BigInt(Math.floor(timestampRaw['NS.time']));
            }

            yield {
              pid,
              message,
              timestamp,
              date,
            };
          }
        }
      } catch (error) {
        // If channel is closed or error occurs, stop generator
        log.warn('Error receiving output events:', error);
        break;
      }
    }
  }
}
