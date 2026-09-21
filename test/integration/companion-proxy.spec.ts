import assert from 'node:assert/strict';
import type {Socket} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {CompanionProxyService} from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('CompanionProxyService.test');
log.level = 'debug';

/** Watch lockdownd: exempt from the source-IP pin. */
const WATCH_LOCKDOWN_PORT = 62078;

describe('CompanionProxyService', {timeout: 60000}, function () {
  let companionProxyService: CompanionProxyService;
  let udid: string;
  let pairedUdids: string[] = [];

  before(async function () {
    udid = requireDeviceUdid();

    companionProxyService = await Services.startCompanionProxyService(udid);
    pairedUdids = await companionProxyService.list();
    log.info(`Paired watches: ${pairedUdids.length ? pairedUdids.join(', ') : '<none>'}`);
  });

  after(async function () {
    try {
      companionProxyService?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('should list paired watches', async function () {
    // [] is valid when no watch is paired.
    assert.ok(Array.isArray(pairedUdids));
    for (const pairedUdid of pairedUdids) {
      assert.strictEqual(typeof pairedUdid, 'string');
      assert.ok(pairedUdid.length > 0);
    }
  });

  it('should read registry values for a paired watch', async function (ctx) {
    if (!pairedUdids.length) {
      ctx.skip();
      return;
    }
    const [watchUdid] = pairedUdids;

    const deviceName = await companionProxyService.getValue(watchUdid, 'DeviceName');
    log.debug(`Watch DeviceName: ${String(deviceName)}`);
    assert.strictEqual(typeof deviceName, 'string');

    const productVersion = await companionProxyService.getValue(watchUdid, 'ProductVersion');
    log.debug(`Watch ProductVersion: ${String(productVersion)}`);
    assert.strictEqual(typeof productVersion, 'string');

    const uniqueDeviceId = await companionProxyService.getValue(watchUdid, 'UniqueDeviceID');
    assert.strictEqual(typeof uniqueDeviceId, 'string');
  });

  it('should report the watch identity consistently', async function (ctx) {
    if (!pairedUdids.length) {
      ctx.skip();
      return;
    }
    const [watchUdid] = pairedUdids;

    // Registry UDID must match the one list() returned.
    const uniqueDeviceId = await companionProxyService.getValue(watchUdid, 'UniqueDeviceID');
    assert.strictEqual(String(uniqueDeviceId).toLowerCase(), watchUdid.toLowerCase());

    const deviceClass = await companionProxyService.getValue(watchUdid, 'DeviceClass');
    assert.strictEqual(deviceClass, 'Watch');

    const productType = await companionProxyService.getValue(watchUdid, 'ProductType');
    log.debug(`Watch ProductType: ${String(productType)}`);
    assert.match(String(productType), /^Watch\d+,\d+$/);

    const buildVersion = await companionProxyService.getValue(watchUdid, 'BuildVersion');
    assert.ok(String(buildVersion).length > 0);
  });

  it('should read live battery and storage telemetry', async function (ctx) {
    if (!pairedUdids.length) {
      ctx.skip();
      return;
    }
    const [watchUdid] = pairedUdids;

    const capacity = await companionProxyService.getValue(watchUdid, 'BatteryCurrentCapacity');
    log.debug(`Watch battery: ${String(capacity)}%`);
    assert.strictEqual(typeof capacity, 'number');
    assert.ok((capacity as number) >= 0 && (capacity as number) <= 100);

    const isCharging = await companionProxyService.getValue(watchUdid, 'BatteryIsCharging');
    log.debug(`Watch charging: ${String(isCharging)}`);
    assert.strictEqual(typeof isCharging, 'boolean');

    const total = await companionProxyService.getValue(watchUdid, 'TotalDataCapacity');
    const available = await companionProxyService.getValue(watchUdid, 'AmountDataAvailable');
    log.debug(`Watch storage: ${String(available)} free of ${String(total)}`);
    assert.strictEqual(typeof total, 'number');
    assert.strictEqual(typeof available, 'number');
    assert.ok((available as number) > 0 && (available as number) <= (total as number));
  });

  it('should reject a value read for a watch that is not paired', async function (ctx) {
    if (!pairedUdids.length) {
      ctx.skip();
      return;
    }
    // A well-formed but unknown UDID must be rejected.
    const unknownUdid = '00000000-000000000000000E';
    await assert.rejects(
      async () => await companionProxyService.getValue(unknownUdid, 'DeviceName'),
      (error: Error & {code?: string}) => {
        log.debug(`Unpaired watch rejected with: ${error.code}`);
        return error.name === 'CompanionProxyError' && error.code === 'NoMatchingWatch';
      },
    );
  });

  it('should forward a watch port and accept a TCP connection', async function (ctx) {
    if (!pairedUdids.length) {
      ctx.skip();
      return;
    }

    const companionPort = await companionProxyService.startForwardingServicePort(WATCH_LOCKDOWN_PORT, {
      serviceName: 'companion-proxy-integration-test',
    });
    log.debug(`Forwarded watch ${WATCH_LOCKDOWN_PORT} -> phone ${companionPort}`);

    let socket: Socket | undefined;
    try {
      // Inside try so a failure still releases the forward.
      assert.strictEqual(typeof companionPort, 'number');
      assert.ok(Number.isInteger(companionPort) && companionPort > 0 && companionPort <= 65535);
      socket = await companionProxyService.connectToForwardedPort(companionPort);
    } finally {
      socket?.destroy();
      await companionProxyService.stopForwardingServicePort(WATCH_LOCKDOWN_PORT);
    }
  });
});
