#!/usr/bin/env node
/**
 * Create lockdown + CoreDeviceProxy tunnels for connected USB devices and expose the tunnel registry API.
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {logger, util} from '@appium/support';
import {
  TunnelManager,
  TunnelReadinessCoordinator,
  createLockdownServiceByUDID,
  createUsbmux,
  startCoreDeviceProxyTcp,
  startTunnelRegistryServer,
  watchTunnelRegistryOnDead,
} from 'appium-ios-remotexpc';
import {Command} from 'commander';

import {DEFAULT_TUNNEL_REGISTRY_PORT} from './lib/constants.mjs';
import {parseNonNegativeIntegerOption, parsePortOption} from './lib/options.mjs';
import {assertRoot} from './lib/root.mjs';
import {sleep} from './lib/timers.mjs';
import {
  createEmptyTunnelRegistry,
  publishDiscoveredTunnelEntry as publishTunnelRegistryEntry,
  refreshServiceCatalog,
} from './lib/tunnel-registry.mjs';

const log = logger.getLogger('TunnelCreation');

/** @type {import('appium-ios-remotexpc').TunnelRegistryServer | null} */
let registryServer = null;

/** @type {DeviceWatcher | null} */
let deviceWatcher = null;

/** @type {Map<string, TunnelCreationSuccessResult>} */
const establishedTunnelsByUdid = new Map();

/** @type {Map<string, () => void>} */
const lifecycleWatchStopByUdid = new Map();

/**
 * @param {import('appium-ios-tuntap').TunnelConnection} tunnelConnection
 * @returns {Promise<void>}
 */
async function closeTunnelQuietly(tunnelConnection) {
  try {
    await tunnelConnection.closer();
  } catch {
    // superseded tunnel may already be stopped
  }
}

/**
 * @param {string} udid
 * @returns {void}
 */
function stopLifecycleWatch(udid) {
  const stop = lifecycleWatchStopByUdid.get(udid);
  if (stop) {
    stop();
    lifecycleWatchStopByUdid.delete(udid);
  }
}

/**
 * @param {TunnelCreationSuccessResult} result
 * @returns {void}
 */
function registerEstablishedTunnel(result) {
  const udid = result.device.Properties.SerialNumber;
  stopLifecycleWatch(udid);

  const previous = establishedTunnelsByUdid.get(udid);
  if (previous?.tunnelConnection && previous.tunnelConnection !== result.tunnelConnection) {
    void closeTunnelQuietly(previous.tunnelConnection);
  }
  establishedTunnelsByUdid.set(udid, result);
}

/**
 * Drops the bookkeeping entry of a tunnel that died, unless a newer tunnel has replaced it already.
 *
 * @param {string} udid
 * @param {string} deadAddress
 * @returns {void}
 */
function forgetEstablishedTunnel(udid, deadAddress) {
  if (establishedTunnelsByUdid.get(udid)?.tunnel.Address === deadAddress) {
    establishedTunnelsByUdid.delete(udid);
  }
}

/**
 *
 * @param {string} connectionType
 * @returns {number}
 */
function connectionTypeRank(connectionType) {
  if (connectionType === 'USB') {
    return 0;
  }
  if (connectionType === 'Network') {
    return 1;
  }
  return 2;
}

/**
 * UDID comparison used elsewhere in the library (`Usbmux.findDevice`, lockdown) is case-insensitive,
 * so a user-supplied `--udid` must match the same way.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameUdid(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * usbmux may list the same UDID twice (USB + Network). Prefer USB for tunneling.
 *
 * @param {import('appium-ios-remotexpc').UsbmuxDevice[]} devices
 */
function dedupeDevicesByUdid(devices) {
  const byUdid = new Map();
  for (const device of devices) {
    const udid = device.Properties.SerialNumber;
    const existing = byUdid.get(udid);
    if (!existing) {
      byUdid.set(udid, device);
      continue;
    }
    if (connectionTypeRank(device.Properties.ConnectionType) < connectionTypeRank(existing.Properties.ConnectionType)) {
      byUdid.set(udid, device);
    }
  }
  return [...byUdid.values()];
}

/**
 *
 * @param {TunnelCreationSuccessResult} result
 * @param {import('appium-ios-remotexpc').TunnelRegistryEntry | undefined} existing
 * @param {number} now
 * @returns {import('appium-ios-remotexpc').TunnelRegistryEntry}
 */
function buildTunnelEntry(result, existing, now) {
  const udid = result.device.Properties.SerialNumber;
  /** @type {import('appium-ios-remotexpc').TunnelRegistryEntry} */
  const entry = {
    udid,
    deviceId: result.device.DeviceID,
    address: result.tunnel.Address,
    rsdPort: result.tunnel.RsdPort,
    services: {},
    // @ts-expect-error - connectionType is not typed
    connectionType: result.device.Properties.ConnectionType,
    // @ts-expect-error - productId is not typed
    productId: result.device.Properties.ProductID,
    createdAt: existing?.createdAt ?? now,
    lastUpdated: now,
  };
  return entry;
}

/**
 * @param {TunnelCreationSuccessResult} result
 * @returns {Promise<boolean>}
 */
async function publishDiscoveredTunnelEntry(result) {
  return await publishTunnelRegistryEntry({
    registryServer,
    result,
    getUdid: (r) => r.device.Properties.SerialNumber,
    buildEntry: buildTunnelEntry,
    log,
  });
}

/** @type {(() => void)[]} */
const registryWatcherStops = [];
/** @type {Map<string, Promise<void>>} */
const reconnectingByUdid = new Map();

/**
 * When the native forwarder exits, drop the UDID from the HTTP registry and tear down state.
 *
 * @param {import('appium-ios-remotexpc').TunnelRegistry} registry
 * @param {TunnelCreationSuccessResult[]} successful
 * @param {object} callbacks
 * @param {function({ udid: string, address: string }): Promise<void>} [callbacks.onTunnelDead]
 * @returns {void}
 */
function attachTunnelRegistryLifecycleWatch(registry, successful, callbacks = {}) {
  for (const result of successful) {
    const udid = result.device.Properties.SerialNumber;
    stopLifecycleWatch(udid);

    const {stop} = watchTunnelRegistryOnDead({
      registry,
      watches: [
        {
          udid,
          registerOnDead: result.registerOnDead,
        },
      ],
      onRemove: async (removedUdid) => {
        registryServer?.removeTunnelEntry(removedUdid);
      },
      onTunnelDead: async ({udid: droppedUdid, address}) => {
        await TunnelManager.closeTunnelByAddress(address).catch(() => {});
        // A dead tunnel must not keep blocking later attaches of this UDID, whether or not a reconnect follows
        forgetEstablishedTunnel(droppedUdid, address);
        if (callbacks.onTunnelDead) {
          await callbacks.onTunnelDead({udid: droppedUdid, address});
        }
      },
    });
    registryWatcherStops.push(stop);
    lifecycleWatchStopByUdid.set(udid, stop);
  }

  log.info('Tunnel registry will update automatically if a native forwarder exits unexpectedly.');
}

/**
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {number} opts.maxRetries
 * @param {import('appium-ios-remotexpc').UsbmuxDevice} opts.device
 * @param {Set<string>} [opts.watchedUdids] - UDIDs currently attached; only defined with `--watch-devices`.
 *   Retrying stops once the UDID is no longer in the set. Without it, retries are never cut short by detach.
 * @param {function(string): Promise<void>} opts.reconnectTunnelByUdid
 * @returns {Promise<void>}
 */
async function runReconnectAttempts({udid, maxRetries, device, watchedUdids, reconnectTunnelByUdid}) {
  let attempt = 0;
  while (maxRetries === 0 || attempt < maxRetries) {
    if (watchedUdids && !watchedUdids.has(udid)) {
      log.info(`Stopped reconnecting ${udid}: device detached`);
      return;
    }
    attempt += 1;
    log.warn(
      `Reconnecting dropped tunnel for ${udid} (attempt ${attempt}${maxRetries === 0 ? ', unlimited mode' : `/${maxRetries}`})...`,
    );

    registryServer?.markTunnelPending(udid);

    const result = await createTunnelForDevice(device);
    if (result.success) {
      attachTunnelRegistryLifecycleWatch(registryServer.getRegistry(), [result], {
        onTunnelDead: async ({udid: droppedUdid}) => {
          await reconnectTunnelByUdid(droppedUdid);
        },
      });
      const ok = await publishDiscoveredTunnelEntry(result);
      if (ok) {
        log.info(`Reconnected tunnel for ${udid}`);
      }
      return;
    }

    await sleep(1000);
  }

  log.error(`Reconnect retries exhausted for ${udid}`);
}

/**
 * @param {object} opts
 * @param {number} opts.reconnectRetries
 * @param {Map<string, import('appium-ios-remotexpc').UsbmuxDevice>} opts.devicesByUdid
 * @param {Set<string>} [opts.watchedUdids] - See {@link runReconnectAttempts}
 * @returns {function(string): Promise<void>}
 */
function createReconnectTunnelByUdid({reconnectRetries, devicesByUdid, watchedUdids}) {
  return async function reconnectTunnelByUdid(udid) {
    if (typeof reconnectRetries !== 'number') {
      return;
    }
    if (reconnectingByUdid.has(udid)) {
      return reconnectingByUdid.get(udid);
    }

    const device = devicesByUdid.get(udid);
    if (!device) {
      log.warn(`Cannot reconnect ${udid}: device context not found`);
      return;
    }

    const run = runReconnectAttempts({
      udid,
      maxRetries: reconnectRetries,
      device,
      watchedUdids,
      reconnectTunnelByUdid,
    });

    reconnectingByUdid.set(udid, run);
    try {
      await run;
    } finally {
      reconnectingByUdid.delete(udid);
    }
  };
}

/**
 * @returns {void}
 */
function setupCleanupHandlers() {
  /**
   * @param {string} signal
   * @returns {Promise<void>}
   */
  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

    deviceWatcher?.stop();

    while (registryWatcherStops.length > 0) {
      const stop = registryWatcherStops.pop();
      try {
        stop?.();
      } catch {}
    }
    lifecycleWatchStopByUdid.clear();

    for (const {tunnelConnection} of establishedTunnelsByUdid.values()) {
      try {
        if (tunnelConnection && typeof tunnelConnection.closer === 'function') {
          log.info('Closing tunnel...');
          await tunnelConnection.closer();
        }
      } catch (err) {
        log.warn(`Error closing tunnel: ${err}`);
      }
    }
    establishedTunnelsByUdid.clear();

    log.info('Cleanup completed.');
  };

  process.on('SIGINT', async () => {
    await cleanup('SIGINT (Ctrl+C)');
    process.exit(process.exitCode || 0);
  });
  process.on('SIGTERM', async () => {
    await cleanup('SIGTERM');
    process.exit(process.exitCode || 0);
  });
  process.on('SIGHUP', async () => {
    await cleanup('SIGHUP');
    process.exit(process.exitCode || 0);
  });

  process.on('uncaughtException', async (error) => {
    log.error('Uncaught Exception:', error);
    await cleanup('Uncaught Exception');
    process.exit(process.exitCode || 1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await cleanup('Unhandled Rejection');
    process.exit(process.exitCode || 1);
  });
}

/**
 * @param {import('appium-ios-remotexpc').UsbmuxDevice} device
 * @returns {Promise<TunnelCreationSuccessResult>}
 */
async function createTunnelForDevice(device) {
  const udid = device.Properties.SerialNumber;

  try {
    log.info(`\n--- Processing device: ${udid} ---`);
    log.info(`Device ID: ${device.DeviceID}`);
    log.info(`Connection Type: ${device.Properties.ConnectionType}`);
    log.info(`Product ID: ${device.Properties.ProductID}`);

    log.info('Creating lockdown service...');
    const {lockdownService, device: lockdownDevice} = await createLockdownServiceByUDID(udid);
    log.info(`Lockdown service created for device: ${lockdownDevice.Properties.SerialNumber}`);

    log.info('Starting CoreDeviceProxy (raw TCP, native OpenSSL forwarder)...');
    const {socket, cert, key} = await startCoreDeviceProxyTcp(
      lockdownService,
      lockdownDevice.DeviceID,
      lockdownDevice.Properties.SerialNumber,
    );
    log.info('CoreDeviceProxy started successfully');

    log.info(`Creating tunnel...`);
    /** @type {{ notify: ((reason: string) => void) | null }} */
    const lifecycle = {notify: null};
    const tunnelConnection = await TunnelManager.getTunnel(
      socket,
      {cert, key},
      {
        onDead: (reason) => lifecycle.notify?.(reason),
      },
    );
    log.info(`Tunnel created for address: ${tunnelConnection.Address} with RsdPort: ${tunnelConnection.RsdPort}`);

    log.info(`✅ Tunnel creation completed successfully for device: ${udid}`);
    log.info(`   Tunnel Address: ${tunnelConnection.Address}`);
    log.info(`   Tunnel RsdPort: ${tunnelConnection.RsdPort}`);

    /** @type {TunnelCreationSuccessResult} */
    const result = {
      // @ts-expect-error - device is not typed
      device,
      tunnel: {
        Address: tunnelConnection.Address,
        RsdPort: tunnelConnection.RsdPort,
      },
      success: true,
      tunnelConnection,
      /**
       * @param {(reason: string) => void} handler
       * @returns {void}
       */
      registerOnDead: (handler) => {
        lifecycle.notify = handler;
      },
    };

    registerEstablishedTunnel(result);
    return result;
  } catch (error) {
    const errorMessage = `Failed to create tunnel for device ${udid}: ${error}`;
    log.error(`❌ ${errorMessage}`);
    return {
      // @ts-expect-error - device is not typed
      device,
      tunnel: {Address: '', RsdPort: 0},
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Tears down the tunnel and registry entry of a device that is no longer attached.
 *
 * @param {string} udid
 * @returns {Promise<void>}
 */
async function removeDetachedDevice(udid) {
  stopLifecycleWatch(udid);
  registryServer?.removeTunnelEntry(udid);
  const established = establishedTunnelsByUdid.get(udid);
  establishedTunnelsByUdid.delete(udid);
  if (established?.tunnelConnection) {
    await closeTunnelQuietly(established.tunnelConnection);
  }
}

/**
 * Follows usbmuxd attach/detach notifications after the initial batch (`--watch-devices`), so
 * devices plugged in or re-trusted later get a tunnel and registry entry without a restart. Only
 * covers devices visible to usbmuxd. Resubscribes if the usbmuxd connection drops (e.g. usbmuxd
 * restarts) and stops once `stop()` is called.
 *
 * Shares state with the reconnect path: an attach is ignored while a tunnel exists or a reconnect
 * is in flight for that UDID, and a detach removes the UDID from `watchedUdids`, which stops any
 * pending reconnect attempts for it.
 */
class DeviceWatcher {
  /**
   * @param {object} opts
   * @param {Map<string, import('appium-ios-remotexpc').UsbmuxDevice>} opts.devicesByUdid - Preferred usbmux entry per tracked UDID, used as device context by reconnects
   * @param {Set<string>} opts.watchedUdids - UDIDs currently attached; shared with the reconnect path
   * @param {string | undefined} opts.specificUdid - When set, events for other UDIDs are ignored
   * @param {function(string): Promise<void>} opts.reconnectTunnelByUdid
   */
  constructor({devicesByUdid, watchedUdids, specificUdid, reconnectTunnelByUdid}) {
    this.devicesByUdid = devicesByUdid;
    this.watchedUdids = watchedUdids;
    this.specificUdid = specificUdid;
    this.reconnectTunnelByUdid = reconnectTunnelByUdid;
    /** @type {Map<number, import('appium-ios-remotexpc').UsbmuxDevice>} */
    this.attachedByDeviceId = new Map();
    this.abortController = new AbortController();
  }

  /**
   * @param {string} udid
   * @returns {import('appium-ios-remotexpc').UsbmuxDevice[]}
   */
  attachedEntriesFor(udid) {
    return [...this.attachedByDeviceId.values()].filter((device) => device.Properties.SerialNumber === udid);
  }

  /**
   * @param {string} udid
   * @returns {void}
   */
  forget(udid) {
    this.devicesByUdid.delete(udid);
    this.watchedUdids.delete(udid);
  }

  /** @returns {void} */
  stop() {
    this.abortController.abort();
  }

  /**
   * @param {import('appium-ios-remotexpc').UsbmuxDeviceEvent} event
   * @returns {Promise<void>}
   */
  async handleEvent(event) {
    switch (event.type) {
      case 'attach':
        await this.handleAttach(event.device);
        break;
      case 'detach':
        await this.handleDetach(event.deviceId);
        break;
      default:
        log.debug(`Ignoring unknown usbmux event: ${JSON.stringify(event)}`);
    }
  }

  /**
   * @param {import('appium-ios-remotexpc').UsbmuxDevice} device
   * @returns {Promise<void>}
   */
  async handleAttach(device) {
    const udid = device.Properties.SerialNumber;
    if (this.specificUdid && !isSameUdid(udid, this.specificUdid)) {
      return;
    }
    this.attachedByDeviceId.set(device.DeviceID, device);
    const [preferred] = dedupeDevicesByUdid(this.attachedEntriesFor(udid));
    this.devicesByUdid.set(udid, preferred);
    this.watchedUdids.add(udid);

    if (establishedTunnelsByUdid.has(udid) || reconnectingByUdid.has(udid)) {
      log.debug(`Ignoring attach of ${udid} (${device.Properties.ConnectionType}): tunnel already managed`);
      return;
    }

    log.info(`\n🔌 Device attached: ${udid}`);
    const result = await createTunnelForDevice(preferred);
    if (!result.success) {
      return;
    }
    attachTunnelRegistryLifecycleWatch(registryServer.getRegistry(), [result], {
      onTunnelDead: async ({udid: droppedUdid}) => {
        await this.reconnectTunnelByUdid(droppedUdid);
      },
    });
    let published = false;
    try {
      published = await publishDiscoveredTunnelEntry(result);
    } catch (err) {
      log.warn(`Failed to publish tunnel for ${udid}: ${err}`);
    }
    if (!published) {
      // Otherwise the live but unpublished tunnel would make every later attach of this UDID a no-op
      await removeDetachedDevice(udid);
    }
  }

  /**
   * @param {number} deviceId
   * @returns {Promise<void>}
   */
  async handleDetach(deviceId) {
    const device = this.attachedByDeviceId.get(deviceId);
    if (!device) {
      return;
    }
    this.attachedByDeviceId.delete(deviceId);
    const udid = device.Properties.SerialNumber;

    const [remaining] = dedupeDevicesByUdid(this.attachedEntriesFor(udid));
    if (remaining) {
      // e.g. USB unplugged while still reachable over Network; the lifecycle watch handles the drop
      log.info(
        `Device ${udid} lost its ${device.Properties.ConnectionType} connection, still attached via ${remaining.Properties.ConnectionType}`,
      );
      this.devicesByUdid.set(udid, remaining);
      return;
    }

    log.info(`\n🔌 Device detached: ${udid}`);
    this.forget(udid);
    await removeDetachedDevice(udid);
  }

  /**
   * Devices unplugged while no subscription was active (during startup, or while usbmuxd was down)
   * are never reported as detached.
   *
   * @returns {Promise<void>}
   */
  async detachDevicesMissingFromUsbmux() {
    const lister = await createUsbmux();
    let listed;
    try {
      listed = new Set((await lister.listDevices()).map((device) => device.Properties.SerialNumber));
    } finally {
      await lister.close().catch((err) => log.warn(`Failed to close usbmux listing connection: ${err}`));
    }
    for (const udid of [...this.watchedUdids]) {
      if (!listed.has(udid)) {
        log.info(`\n🔌 Device detached while usbmuxd was unavailable: ${udid}`);
        this.forget(udid);
        await removeDetachedDevice(udid);
      }
    }
  }

  /**
   * Runs the subscribe/handle/resubscribe loop until `stop()` is called.
   *
   * @returns {Promise<void>}
   */
  async run() {
    const {signal} = this.abortController;
    let backoffMs = 1000;

    while (!signal.aborted) {
      /** @type {import('appium-ios-remotexpc').Usbmux | null} */
      let usbmux = null;
      try {
        usbmux = await createUsbmux();
        // Listen re-reports every attached device, possibly under new DeviceIDs (e.g. replugged while
        // startup was still creating tunnels, or usbmuxd restarted), so entries from before are stale
        this.attachedByDeviceId.clear();
        const events = usbmux.listen({signal});
        log.info('Watching usbmuxd for device attach/detach events...');
        await this.detachDevicesMissingFromUsbmux();
        for await (const event of events) {
          backoffMs = 1000;
          try {
            await this.handleEvent(event);
          } catch (err) {
            // One failed event must not end the subscription
            log.warn(`Failed to handle usbmux ${event.type} event: ${err}`);
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          log.warn(`Device watch interrupted (${err}); resubscribing in ${backoffMs}ms`);
        }
      } finally {
        await usbmux?.close().catch((err) => log.warn(`Failed to close usbmux watch connection: ${err}`));
      }
      if (signal.aborted) {
        break;
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  setupCleanupHandlers();

  const program = new Command();
  program
    .name('tunnel-creation')
    .description('Create tunnels for connected USB devices (lockdown + CoreDeviceProxy)')
    .argument('[udid]', 'Optional device UDID (omit for all devices)')
    .option('--udid <udid>', 'UDID of the device to create tunnel for')
    .option('-k, --keep-open', 'Keep connections open for lsof inspection')
    .option(
      '--tunnel-registry-port <port>',
      `Port for tunnel registry API (default: ${DEFAULT_TUNNEL_REGISTRY_PORT})`,
      (value) => parsePortOption(value, 'tunnel registry port'),
    )
    .option('--reconnect-retries <count>', 'Reconnect retries after unexpected tunnel drop (0 = unlimited)', (value) =>
      parseNonNegativeIntegerOption(value, 'retry count'),
    )
    .option(
      '--watch-devices',
      'Keep watching usbmuxd after startup: create tunnels for newly attached devices and remove detached ones (usbmux-visible devices only). ' +
        'With --udid, only that UDID is watched, and startup no longer requires it to already be connected. ' +
        'Tunnels created after startup use the same --reconnect-retries policy as the initial ones. Independent of --keep-open.',
    );

  program.parse(process.argv);
  const options = program.opts();
  const specificUdid = options.udid ?? program.args[0] ?? undefined;

  await assertRoot(path.join('scripts', path.basename(fileURLToPath(import.meta.url))));

  if (specificUdid) {
    log.info(`Starting tunnel creation test for specific UDID: ${specificUdid}`);
  } else {
    log.info('Starting tunnel creation test for all connected devices');
  }

  if (options.keepOpen) {
    log.info('Running in "keep connections open" mode for lsof inspection');
  }

  const registryPort = options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;

  try {
    log.info('Connecting to usbmuxd...');
    const usbmux = await createUsbmux();

    log.info('Listing all connected devices...');
    const devices = await usbmux.listDevices();

    await usbmux.close();

    if (devices.length === 0 && !options.watchDevices) {
      log.warn('No devices found. Make sure iOS devices are connected and trusted.');
      process.exit(0);
    }

    log.info(`Found ${util.pluralize('connected device', devices.length, true)}:`);
    devices.forEach((device, index) => {
      log.info(`  ${index + 1}. UDID: ${device.Properties.SerialNumber}`);
      log.info(`     Device ID: ${device.DeviceID}`);
      log.info(`     Connection: ${device.Properties.ConnectionType}`);
      log.info(`     Product ID: ${device.Properties.ProductID}`);
    });

    let devicesToProcess = devices;
    if (specificUdid) {
      devicesToProcess = devices.filter((device) => isSameUdid(device.Properties.SerialNumber, specificUdid));

      if (devicesToProcess.length === 0 && options.watchDevices) {
        log.warn(`Device with UDID ${specificUdid} is not connected yet; waiting for it to attach.`);
      } else if (devicesToProcess.length === 0) {
        log.error(`Device with UDID ${specificUdid} not found in connected devices.`);
        log.error('Available devices:');
        devices.forEach((device) => {
          log.error(`  - ${device.Properties.SerialNumber}`);
        });
        process.exit(1);
      }
    }

    const beforeDedupe = devicesToProcess.length;
    devicesToProcess = dedupeDevicesByUdid(devicesToProcess);
    if (devicesToProcess.length < beforeDedupe) {
      log.info(
        `Deduped ${util.pluralize('usbmux entry', beforeDedupe, true)} to ${util.pluralize('device', devicesToProcess.length, true)} (USB preferred over Network)`,
      );
    }

    log.info(`\nProcessing ${util.pluralize('device', devicesToProcess.length, true)}...`);

    const readiness = new TunnelReadinessCoordinator();
    const registry = createEmptyTunnelRegistry();

    registryServer = await startTunnelRegistryServer(registry, registryPort, {
      readiness,
      refreshServices: async (udid, entry) => await refreshServiceCatalog(udid, entry, log),
    });

    const reconnectRetries = options.reconnectRetries;
    const devicesByUdid = new Map(devicesToProcess.map((device) => [device.Properties.SerialNumber, device]));
    const watchedUdids = options.watchDevices ? new Set(devicesByUdid.keys()) : undefined;
    const reconnectTunnelByUdid = createReconnectTunnelByUdid({
      reconnectRetries,
      devicesByUdid,
      watchedUdids,
    });

    const results = [];
    const successful = [];

    for (const device of devicesToProcess) {
      const result = await createTunnelForDevice(device);
      results.push(result);

      if (result.success) {
        attachTunnelRegistryLifecycleWatch(registryServer.getRegistry(), [result], {
          /**
           * @param {{ udid: string }} ctx
           * @returns {Promise<void>}
           */
          onTunnelDead: async ({udid}) => {
            await reconnectTunnelByUdid(udid);
          },
        });
        const published = await publishDiscoveredTunnelEntry(result);
        if (published) {
          successful.push(result);
        }
      }

      if (devicesToProcess.length > 1) {
        await sleep(1000);
      }
    }

    log.info('\n=== TUNNEL CREATION SUMMARY ===');
    const failed = results.filter((r) => !r.success);

    log.info(`Total ${util.pluralize('device', results.length, true)} processed`);
    log.info(`Successful ${util.pluralize('tunnel', successful.length, true)}`);
    log.info(`Failed ${util.pluralize('tunnel', failed.length, true)}`);

    if (successful.length > 0) {
      log.info(`\n✅ Successful ${util.pluralize('tunnel', successful.length)}:`);
      log.info('\n📁 Tunnel registry API:');
      log.info('   The tunnel registry is now available through the API at:');
      log.info(`   http://localhost:${registryPort}/remotexpc/tunnels`);
      log.info('\n   Available endpoints:');
      log.info('   - GET /remotexpc/tunnels - List all tunnels');
      log.info('   - GET /remotexpc/tunnels/:udid?waitMs=15000 - Get tunnel (long-poll until catalog ready)');
      log.info('   - POST /remotexpc/tunnels/:udid/refresh-services - Re-discover RSD catalog');
      log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

      log.info('\n💡 Example usage:');
      log.info(`   curl http://localhost:${registryPort}/remotexpc/tunnels`);
      log.info(`   curl http://localhost:${registryPort}/remotexpc/tunnels/metadata`);
      const firstUdid = successful[0].device.Properties.SerialNumber;
      log.info(`   curl "http://localhost:${registryPort}/remotexpc/tunnels/${firstUdid}?waitMs=15000"`);
    }

    if (options.watchDevices) {
      deviceWatcher = new DeviceWatcher({
        devicesByUdid,
        watchedUdids,
        specificUdid,
        reconnectTunnelByUdid,
      });
      await deviceWatcher.run();
    }
  } catch (error) {
    log.error(`Error during tunnel creation test: ${error}`);
    throw error;
  }
}

await main();

/**
 * Successful tunnel row (USB lockdown + CoreDeviceProxy) used for the registry and lifecycle watch.
 *
 * @typedef {object} TunnelCreationSuccessResult
 * @property {{ Properties: { SerialNumber: string, [key: string]: unknown }, DeviceID: number }} device
 * @property {{ Address: string, RsdPort?: number }} tunnel
 * @property {import('appium-ios-tuntap').TunnelConnection} tunnelConnection
 * @property {(handler: (reason: string) => void) => void} registerOnDead
 * @property {boolean} success
 */
