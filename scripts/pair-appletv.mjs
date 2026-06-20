#!/usr/bin/env node
/**
 * Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels.
 *
 * Usage:
 *   npm run pair-appletv -- [options]
 */

import { logger } from '@appium/support';
import { Command } from 'commander';
import {
  AppleTVPairingService,
  UserInputService,
} from 'appium-ios-remotexpc';
import { DEFAULT_PAIRING_CONFIG } from '../build/src/lib/apple-tv/constants.js';

const log = logger.getLogger('AppleTVPairing');
const APPLETV_PAIRING_DISCOVERY_PROGRESS_INTERVAL_MS = 1000;
const APPLETV_PAIRING_DISCOVERY_PROGRESS_BAR_WIDTH = 24;

function parsePositiveInteger(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(
      `Invalid timeout: ${value}. Expected a positive integer in milliseconds.`,
    );
  }
  return count;
}

function startTimeoutProgressLogger({
  label,
  startedAt,
  timeoutMs,
  barWidth,
  intervalMs,
}) {
  let timer = null;
  let isStopped = false;

  const logProgress = (status, isComplete = false) => {
    const elapsedMs = performance.now() - startedAt;
    const boundedElapsedMs = Math.min(elapsedMs, timeoutMs);
    const progress = isComplete ? 1 : boundedElapsedMs / timeoutMs;
    const filledWidth = Math.round(progress * barWidth);
    const emptyWidth = barWidth - filledWidth;
    const bar = `${'#'.repeat(filledWidth)}${'-'.repeat(emptyWidth)}`;
    log.info(
      `${label}: [${bar}]${status && status !== 'waiting' ? ` - ${status}` : ''}`,
    );
  };

  const stop = (status, isComplete = false) => {
    if (isStopped) {
      return;
    }
    isStopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logProgress(status, isComplete);
  };

  logProgress('waiting');
  timer = setInterval(() => {
    logProgress('waiting');
  }, intervalMs);
  timer.unref?.();

  return {
    succeed: (message = 'done') => stop(message, true),
    fail: (message = 'failed') => stop(message),
  };
}

function discoverAppleTVPairingDevices(pairingService, timeoutMs) {
  const startedAt = performance.now();
  const promise = pairingService.discoverDevices({ timeoutMs });
  return { startedAt, promise };
}

async function waitForAppleTVPairingDiscovery(discovery, timeoutMs) {
  const progress = startTimeoutProgressLogger({
    label: 'Waiting for Apple TV pairing discovery',
    startedAt: discovery.startedAt,
    timeoutMs,
    barWidth: APPLETV_PAIRING_DISCOVERY_PROGRESS_BAR_WIDTH,
    intervalMs: APPLETV_PAIRING_DISCOVERY_PROGRESS_INTERVAL_MS,
  });

  try {
    const devices = await discovery.promise;
    progress.succeed(
      `Apple TV pairing discovery completed: ${devices.length} device(s) found`,
    );
    return devices;
  } catch (err) {
    progress.fail('Apple TV pairing discovery failed');
    throw err;
  }
}

async function main() {
  const program = new Command();
  program
    .name('pair-appletv')
    .description('Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels')
    .option(
      '-d, --device <selector>',
      'Device selector: name, identifier (e.g. AA:BB:CC:DD:EE:FF), or index (0, 1, …)',
    )
    .option(
      '--discovery-timeout <ms>',
      'Apple TV pairing discovery timeout in milliseconds',
      parsePositiveInteger,
    );

  program.parse(process.argv);
  const options = program.opts();
  const discoveryTimeoutMs =
    options.discoveryTimeout ?? DEFAULT_PAIRING_CONFIG.discoveryTimeout;

  const userInput = new UserInputService();
  const pairingService = new AppleTVPairingService(userInput);
  const discovery = discoverAppleTVPairingDevices(
    pairingService,
    discoveryTimeoutMs,
  );
  const devices = await waitForAppleTVPairingDiscovery(
    discovery,
    discoveryTimeoutMs,
  );
  const result = await pairingService.discoverAndPair(options.device, {
    devices,
    discoveryTimeoutMs,
  });

  if (result.success) {
    log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
  } else {
    throw result.error ?? new Error('Pairing failed');
  }
}

await main();
