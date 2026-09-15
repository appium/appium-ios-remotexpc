import assert from 'node:assert/strict';
import {type TestContext, describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {AmfiError, DeviceHasPasscodeSetError} from '../../../src/services/ios/amfi/errors.js';
import {AmfiService, DeveloperModeAction} from '../../../src/services/ios/amfi/index.js';
import {mockImport} from '../../helpers/mock-module.js';

const UDID = 'phone-udid';
const AMFI_SERVICE_NAME = 'com.apple.amfi.lockdown.shim.remote';
const MOUNTER_SERVICE_NAME = 'com.apple.mobile.mobile_image_mounter.shim.remote';
const GREETING: PlistDictionary = {Request: 'StartService'};
const SUCCESS: PlistDictionary = {success: true};
const STATUS_QUERY: PlistDictionary = {Command: 'QueryDeveloperModeStatus'};
const STATUS_ON: PlistDictionary = {DeveloperModeStatus: true};
const STATUS_OFF: PlistDictionary = {DeveloperModeStatus: false};

interface FakeConnection {
  sentRequests: PlistDictionary[];
  timeouts: Array<number | undefined>;
  closeCount: number;
  sendPlistRequest(request: PlistDictionary, timeout?: number): Promise<PlistDictionary>;
  receive(timeout?: number): Promise<PlistDictionary>;
  close(): void;
}

/**
 * Fake ServiceConnection whose inbound frames are served in order to both
 * `receive()` and `sendPlistRequest()` (which the real class implements as send + receive).
 */
function createFakeConnection(inbound: Array<PlistDictionary | Error>): FakeConnection {
  const frames = [...inbound];
  const conn: FakeConnection = {
    sentRequests: [],
    timeouts: [],
    closeCount: 0,
    async sendPlistRequest(request, timeout) {
      conn.sentRequests.push(request);
      return await conn.receive(timeout);
    },
    async receive(timeout) {
      conn.timeouts.push(timeout);
      const frame = frames.shift();
      if (frame === undefined) {
        throw new Error('fake connection has no more inbound frames');
      }
      if (frame instanceof Error) {
        throw frame;
      }
      return frame;
    },
    close() {
      conn.closeCount++;
    },
  };
  return conn;
}

interface StartedService {
  serviceName: string;
  options?: Record<string, unknown>;
}

interface Harness {
  service: AmfiService;
  startedServices: StartedService[];
}

/**
 * Imports the service with BaseService replaced so each `startLockdownService` call hands
 * out the next fake connection, in order.
 */
async function createService(t: TestContext, connections: FakeConnection[], timeout?: number): Promise<Harness> {
  const pending = [...connections];
  const startedServices: StartedService[] = [];

  const {AmfiService: MockedService} = await mockImport<{AmfiService: typeof AmfiService}>(
    t,
    '../../../src/services/ios/amfi/index.js',
    import.meta.url,
    {
      '../../../src/services/ios/base-service.js': {
        BaseService: class {
          constructor(readonly udid: string) {}
          async startLockdownService(serviceName: string, options?: Record<string, unknown>): Promise<FakeConnection> {
            startedServices.push({serviceName, options});
            const conn = pending.shift();
            if (!conn) {
              throw new Error('no fake connection left for startLockdownService');
            }
            return conn;
          }
        },
      },
    },
  );

  return {service: new MockedService(UDID, timeout), startedServices};
}

function startedNames(harness: Harness): string[] {
  return harness.startedServices.map((started) => started.serviceName);
}

async function rejectsWithAmfiError(promise: Promise<unknown>, expected: {name: string; code?: string}): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AmfiError, `expected AmfiError, got ${String(error)}`);
    assert.strictEqual(error.name, expected.name);
    assert.strictEqual(error.code, expected.code);
    return true;
  });
}

describe('AmfiService', function () {
  it('exposes the RSD shim service name', function () {
    assert.strictEqual(AmfiService.RSD_SERVICE_NAME, AMFI_SERVICE_NAME);
  });

  it('maps the Developer Mode actions to the daemon integers', function () {
    assert.strictEqual(DeveloperModeAction.REVEAL, 0);
    assert.strictEqual(DeveloperModeAction.ENABLE, 1);
    assert.strictEqual(DeveloperModeAction.ACCEPT, 2);
  });

  describe('isDeveloperModeEnabled', function () {
    it('queries the image mounter shim after draining its greeting and closes', async function (t) {
      const conn = createFakeConnection([GREETING, STATUS_ON]);
      const harness = await createService(t, [conn]);

      assert.strictEqual(await harness.service.isDeveloperModeEnabled(), true);
      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
      assert.deepStrictEqual(conn.sentRequests, [STATUS_QUERY]);
      assert.strictEqual(conn.closeCount, 1);
    });

    for (const [reply, expected] of [
      [STATUS_OFF, false],
      [{DeveloperModeStatus: 1}, true],
      [{DeveloperModeStatus: 0}, false],
    ] as Array<[PlistDictionary, boolean]>) {
      it(`reads ${JSON.stringify(reply)} as ${expected}`, async function (t) {
        const {service} = await createService(t, [createFakeConnection([GREETING, reply])]);
        assert.strictEqual(await service.isDeveloperModeEnabled(), expected);
      });
    }

    it('throws AmfiError when the daemon reports an error', async function (t) {
      const {service} = await createService(t, [createFakeConnection([GREETING, {Error: 'InternalError'}])]);
      await rejectsWithAmfiError(service.isDeveloperModeEnabled(), {name: 'AmfiError', code: 'InternalError'});
    });

    it('throws AmfiError when the reply carries no recognisable status', async function (t) {
      const {service} = await createService(t, [createFakeConnection([GREETING, {}])]);
      await rejectsWithAmfiError(service.isDeveloperModeEnabled(), {name: 'AmfiError'});
    });
  });

  describe('revealDeveloperModeOption', function () {
    it('drains the StartService greeting, sends {action: 0} and closes', async function (t) {
      const conn = createFakeConnection([GREETING, SUCCESS]);
      const harness = await createService(t, [conn]);

      await harness.service.revealDeveloperModeOption();

      assert.deepStrictEqual(startedNames(harness), [AMFI_SERVICE_NAME]);
      assert.deepStrictEqual(conn.sentRequests, [{action: 0}]);
      assert.strictEqual(conn.closeCount, 1);
    });
  });

  describe('acceptDeveloperModePrompt', function () {
    it('reads the status first, then sends {action: 2} when Developer Mode is off', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_OFF]);
      const amfi = createFakeConnection([GREETING, SUCCESS]);
      const harness = await createService(t, [status, amfi]);

      await harness.service.acceptDeveloperModePrompt();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME, AMFI_SERVICE_NAME]);
      assert.deepStrictEqual(status.sentRequests, [STATUS_QUERY]);
      assert.deepStrictEqual(amfi.sentRequests, [{action: 2}]);
      assert.strictEqual(status.closeCount, 1);
      assert.strictEqual(amfi.closeCount, 1);
    });

    it('is a no-op when Developer Mode is already on', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_ON]);
      const harness = await createService(t, [status]);

      await harness.service.acceptDeveloperModePrompt();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
      assert.strictEqual(status.closeCount, 1);
    });

    it('stays a no-op when already on even though a passcode would otherwise block accept', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_ON]);
      // AMFI rejects action 2 with the passcode error when no prompt is pending, but accept must never reach it.
      const amfi = createFakeConnection([GREETING, {Error: 'Device has a passcode set'}]);
      const harness = await createService(t, [status, amfi]);

      await harness.service.acceptDeveloperModePrompt();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
      assert.deepStrictEqual(amfi.sentRequests, []);
      assert.strictEqual(amfi.closeCount, 0);
    });

    it('surfaces the no-prompt-pending error when off and nothing is pending', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_OFF]);
      const amfi = createFakeConnection([GREETING, {Error: 'An unknown error has occured'}]);
      const {service} = await createService(t, [status, amfi]);

      await rejectsWithAmfiError(service.acceptDeveloperModePrompt(), {
        name: 'AmfiError',
        code: 'An unknown error has occured',
      });
      assert.deepStrictEqual(amfi.sentRequests, [{action: 2}]);
    });
  });

  describe('enableDeveloperMode', function () {
    it('reads the status first, then sends {action: 1} when Developer Mode is off', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_OFF]);
      const amfi = createFakeConnection([GREETING, SUCCESS]);
      const harness = await createService(t, [status, amfi]);

      await harness.service.enableDeveloperMode();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME, AMFI_SERVICE_NAME]);
      assert.deepStrictEqual(status.sentRequests, [STATUS_QUERY]);
      assert.deepStrictEqual(amfi.sentRequests, [{action: 1}]);
      assert.strictEqual(status.closeCount, 1);
      assert.strictEqual(amfi.closeCount, 1);
    });

    it('is a no-op when Developer Mode is already on', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_ON]);
      const harness = await createService(t, [status]);

      await harness.service.enableDeveloperMode();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
      assert.strictEqual(status.closeCount, 1);
    });

    it('stays a no-op when already on even though a passcode would otherwise block enable', async function (t) {
      const status = createFakeConnection([GREETING, STATUS_ON]);
      // This AMFI connection would reject with the passcode error, but enable must never reach it.
      const amfi = createFakeConnection([GREETING, {Error: 'Device has a passcode set'}]);
      const harness = await createService(t, [status, amfi]);

      await harness.service.enableDeveloperMode();

      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
      assert.deepStrictEqual(amfi.sentRequests, []);
      assert.strictEqual(amfi.closeCount, 0);
    });

    it('does not send the action when the status read fails', async function (t) {
      const status = createFakeConnection([GREETING, {Error: 'InternalError'}]);
      const harness = await createService(t, [status]);

      await rejectsWithAmfiError(harness.service.enableDeveloperMode(), {name: 'AmfiError', code: 'InternalError'});
      assert.deepStrictEqual(startedNames(harness), [MOUNTER_SERVICE_NAME]);
    });

    it('accepts integer 1 as success, which the daemon sends for enable', async function (t) {
      const amfi = createFakeConnection([GREETING, {success: 1}]);
      const {service} = await createService(t, [createFakeConnection([GREETING, STATUS_OFF]), amfi]);

      await service.enableDeveloperMode();

      assert.deepStrictEqual(amfi.sentRequests, [{action: 1}]);
      assert.strictEqual(amfi.closeCount, 1);
    });

    it('throws DeviceHasPasscodeSetError when blocked by a passcode', async function (t) {
      const amfi = createFakeConnection([GREETING, {Error: 'Device has a passcode set'}]);
      const {service} = await createService(t, [createFakeConnection([GREETING, STATUS_OFF]), amfi]);

      await assert.rejects(service.enableDeveloperMode(), (error: unknown) => {
        assert.ok(
          error instanceof DeviceHasPasscodeSetError,
          `expected DeviceHasPasscodeSetError, got ${String(error)}`,
        );
        assert.ok(error instanceof AmfiError);
        assert.strictEqual(error.name, 'DeviceHasPasscodeSetError');
        assert.strictEqual(error.code, 'Device has a passcode set');
        return true;
      });
      assert.strictEqual(amfi.closeCount, 1);
    });

    it('throws AmfiError carrying the daemon error string for other rejections', async function (t) {
      const amfi = createFakeConnection([GREETING, {Error: 'Something else'}]);
      const {service} = await createService(t, [createFakeConnection([GREETING, STATUS_OFF]), amfi]);

      await rejectsWithAmfiError(service.enableDeveloperMode(), {name: 'AmfiError', code: 'Something else'});
    });
  });

  describe('connection handling', function () {
    it('opens a fresh checked-in connection for every call', async function (t) {
      const first = createFakeConnection([GREETING, SUCCESS]);
      const second = createFakeConnection([GREETING, SUCCESS]);
      const harness = await createService(t, [first, second]);

      await harness.service.revealDeveloperModeOption();
      await harness.service.revealDeveloperModeOption();

      assert.strictEqual(harness.startedServices.length, 2);
      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 1);
    });

    it('applies the configured timeout to connect, greeting and reply', async function (t) {
      const conn = createFakeConnection([GREETING, SUCCESS]);
      const harness = await createService(t, [conn], 1234);

      await harness.service.revealDeveloperModeOption();

      assert.deepStrictEqual(harness.startedServices[0].options, {createConnectionTimeout: 1234});
      assert.deepStrictEqual(conn.timeouts, [1234, 1234]);
    });

    it('rejects and closes without sending when the greeting is not StartService', async function (t) {
      const conn = createFakeConnection([{Request: 'SomethingElse'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithAmfiError(service.revealDeveloperModeOption(), {name: 'AmfiError'});
      assert.deepStrictEqual(conn.sentRequests, []);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('surfaces an Error carried in the greeting', async function (t) {
      const conn = createFakeConnection([{Error: 'ServiceProhibited'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithAmfiError(service.revealDeveloperModeOption(), {name: 'AmfiError', code: 'ServiceProhibited'});
      assert.deepStrictEqual(conn.sentRequests, []);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('closes the connection when the transport fails mid-request', async function (t) {
      const conn = createFakeConnection([GREETING, new Error('socket hang up')]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.revealDeveloperModeOption(), /socket hang up/);
      assert.strictEqual(conn.closeCount, 1);
    });
  });

  describe('daemon replies', function () {
    it('throws AmfiError when the reply lacks success', async function (t) {
      const {service} = await createService(t, [createFakeConnection([GREETING, {}])]);
      await rejectsWithAmfiError(service.revealDeveloperModeOption(), {name: 'AmfiError'});
    });

    it('throws AmfiError when success is 0', async function (t) {
      const {service} = await createService(t, [createFakeConnection([GREETING, {success: 0}])]);
      await rejectsWithAmfiError(service.revealDeveloperModeOption(), {name: 'AmfiError'});
    });

    it('throws AmfiError when success is false', async function (t) {
      const {service} = await createService(t, [createFakeConnection([GREETING, {success: false}])]);
      await rejectsWithAmfiError(service.revealDeveloperModeOption(), {name: 'AmfiError'});
    });
  });
});
