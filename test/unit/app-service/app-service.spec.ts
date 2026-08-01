import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants as osConstants} from 'node:os';
import {describe, it} from 'node:test';

import {CoreDeviceError} from '../../../src/index.js';
import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary, XPCValue} from '../../../src/lib/types.js';
import {AppService} from '../../../src/services/ios/app-service/index.js';

type Responder = (sentBody: XPCDictionary) => XPCDictionary | null;

/**
 * Fake framed transport: captures every sent XPC body and, for each request,
 * emits a canned reply on the next microtask (mirroring a device response).
 */
class FakeTransport extends EventEmitter {
  isConnected = true;
  closeCalls = 0;
  readonly sentBodies: XPCDictionary[] = [];

  constructor(private responder: Responder) {
    super();
  }

  sendDataFrame(payload: Buffer): void {
    const {message} = decodeMessage(payload);
    const body = message.body as XPCDictionary;
    this.sentBodies.push(body);
    const reply = this.responder(body);
    if (reply) {
      queueMicrotask(() => this.emit('message', reply));
    }
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

class TestAppService extends AppService {
  constructor(readonly fake: FakeTransport) {
    super('test-udid');
  }

  protected async createTransport(): Promise<any> {
    return this.fake;
  }
}

function feature(body: XPCDictionary): string {
  return body['CoreDevice.featureIdentifier'] as string;
}

function input(body: XPCDictionary): XPCDictionary {
  return body['CoreDevice.input'] as XPCDictionary;
}

function reply(output: XPCValue): XPCDictionary {
  return {'CoreDevice.output': output};
}

describe('AppService', function () {
  describe('CoreDevice envelope', function () {
    it('wraps every request in the CoreDevice invocation envelope', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps();

      const sent = fake.sentBodies[0];
      assert.strictEqual(sent['CoreDevice.CoreDeviceDDIProtocolVersion'], 2);
      assert.deepStrictEqual(sent['CoreDevice.coreDeviceVersion'], {
        components: [629, 3],
        originalComponentsCount: 2,
        stringValue: '629.3',
      });
      assert.strictEqual(sent['CoreDevice.featureIdentifier'], 'com.apple.coredevice.feature.listapps');
      assert.deepStrictEqual(sent['CoreDevice.action'], {});
      assert.ok(typeof sent['CoreDevice.deviceIdentifier'] === 'string');
      assert.ok(typeof sent['CoreDevice.invocationIdentifier'] === 'string');
      // Each invocation gets a fresh identifier.
      assert.notStrictEqual(sent['CoreDevice.deviceIdentifier'], sent['CoreDevice.invocationIdentifier']);
    });
  });

  describe('listApps', function () {
    it('sends all include flags and returns the output array', async function () {
      const apps = [{bundleIdentifier: 'com.apple.Preferences'}];
      const fake = new FakeTransport((body) =>
        feature(body) === 'com.apple.coredevice.feature.listapps' ? reply(apps) : null,
      );
      const service = new TestAppService(fake);

      const result = await service.listApps();

      assert.deepStrictEqual(input(fake.sentBodies[0]), {
        includeAppClips: true,
        includeRemovableApps: true,
        includeHiddenApps: true,
        includeInternalApps: true,
        includeDefaultApps: true,
        requireContainerAccess: false,
        includeAppGroupIdentifiers: false,
        includeContainerPaths: false,
      });
      assert.deepStrictEqual(result, apps);
    });

    it('honors explicit include options', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps({includeHiddenApps: false});

      assert.strictEqual(input(fake.sentBodies[0]).includeHiddenApps, false);
      assert.strictEqual(input(fake.sentBodies[0]).includeAppClips, true);
    });

    it('forwards the iOS 26 container/metadata flags', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps({
        requireContainerAccess: true,
        includeAppGroupIdentifiers: true,
        includeContainerPaths: true,
      });

      const sent = input(fake.sentBodies[0]);
      assert.strictEqual(sent.requireContainerAccess, true);
      assert.strictEqual(sent.includeAppGroupIdentifiers, true);
      assert.strictEqual(sent.includeContainerPaths, true);
    });
  });

  describe('launchApplication', function () {
    it('builds the launch input and surfaces the process id', async function () {
      const fake = new FakeTransport(() => reply({processToken: {processIdentifier: 99}}));
      const service = new TestAppService(fake);

      const launched = await service.launchApplication('com.apple.Preferences', {
        arguments: ['--foo'],
        environment: {A: 'B'},
      });

      const sentInput = input(fake.sentBodies[0]);
      assert.deepStrictEqual(sentInput.applicationSpecifier, {
        bundleIdentifier: {_0: 'com.apple.Preferences'},
      });
      const opts = sentInput.options as XPCDictionary;
      assert.deepStrictEqual(opts.arguments, ['--foo']);
      assert.deepStrictEqual(opts.environmentVariables, {A: 'B'});
      assert.strictEqual(opts.terminateExisting, true);
      assert.strictEqual(opts.startStopped, false);
      assert.deepStrictEqual(opts.user, {shortName: 'mobile'});
      // platformSpecificOptions is a serialized plist (XPC data -> Buffer).
      assert.strictEqual(Buffer.isBuffer(opts.platformSpecificOptions), true);
      assert.ok((opts.platformSpecificOptions as Buffer).toString('utf8').includes('plist'));

      assert.strictEqual(launched.processIdentifier, 99);
      assert.deepStrictEqual(launched.processToken, {processIdentifier: 99});
    });

    it('defaults arguments/environment and allows disabling terminateExisting', async function () {
      const fake = new FakeTransport(() => reply({processToken: {}}));
      const service = new TestAppService(fake);

      await service.launchApplication('com.x', {terminateExisting: false});

      const opts = input(fake.sentBodies[0]).options as XPCDictionary;
      assert.deepStrictEqual(opts.arguments, []);
      assert.deepStrictEqual(opts.environmentVariables, {});
      assert.strictEqual(opts.terminateExisting, false);
    });
  });

  describe('listProcesses', function () {
    it('returns the processTokens array from the output', async function () {
      const tokens = [{processIdentifier: 1}, {processIdentifier: 42, executableURL: {relative: '/x'}}];
      const fake = new FakeTransport(() => reply({processTokens: tokens}));
      const service = new TestAppService(fake);

      const result = await service.listProcesses();

      assert.strictEqual(feature(fake.sentBodies[0]), 'com.apple.coredevice.feature.listprocesses');
      assert.deepStrictEqual(result, tokens);
    });
  });

  describe('sendSignalToProcess', function () {
    it('sends the pid and signal as the input', async function () {
      const fake = new FakeTransport(() => reply({}));
      const service = new TestAppService(fake);

      await service.sendSignalToProcess(123, osConstants.signals.SIGKILL);

      assert.strictEqual(feature(fake.sentBodies[0]), 'com.apple.coredevice.feature.sendsignaltoprocess');
      assert.deepStrictEqual(input(fake.sentBodies[0]), {
        process: {processIdentifier: 123},
        signal: osConstants.signals.SIGKILL,
      });
    });
  });

  describe('uninstallApp', function () {
    it('sends the bundle identifier', async function () {
      const fake = new FakeTransport(() => reply({}));
      const service = new TestAppService(fake);

      await service.uninstallApp('com.apple.Preferences');

      assert.strictEqual(feature(fake.sentBodies[0]), 'com.apple.coredevice.feature.uninstallapp');
      assert.deepStrictEqual(input(fake.sentBodies[0]), {
        bundleIdentifier: 'com.apple.Preferences',
      });
    });
  });

  describe('error handling', function () {
    it('throws CoreDeviceError when the reply has no output', async function () {
      const fake = new FakeTransport(() => ({'CoreDevice.error': 'boom'}));
      const service = new TestAppService(fake);

      let caught: unknown;
      try {
        await service.listApps();
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof CoreDeviceError);
    });

    it('surfaces the device NSError reason in the message', async function () {
      const fake = new FakeTransport(() => ({
        'CoreDevice.error': {
          domain: 'com.apple.dt.CoreDeviceError',
          code: 10002,
          userInfo: {
            NSLocalizedDescription: 'The application failed to launch.',
            NSLocalizedFailureReason: 'The requested application com.foo.bar is not installed.',
          },
        },
      }));
      const service = new TestAppService(fake);

      let caught: unknown;
      try {
        await service.launchApplication('com.foo.bar');
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof CoreDeviceError);
      const message = (caught as Error).message;
      assert.ok(message.includes('is not installed'));
      assert.ok(message.includes('com.apple.dt.CoreDeviceError'));
      assert.ok(message.includes('10002'));
    });

    it('times out when no reply arrives', async function () {
      const fake = new FakeTransport(() => null);
      const service = new TestAppService(fake);

      let caught: unknown;
      try {
        await service.launchApplication('com.x', {timeoutMs: 50});
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof CoreDeviceError);
      assert.ok((caught as Error).message.includes('timed out'));
    });
  });

  describe('serialization of concurrent invocations', function () {
    it('does not interleave replies across concurrent calls', async function () {
      const fake = new FakeTransport((body) => {
        if (feature(body) === 'com.apple.coredevice.feature.listapps') {
          return reply([{bundleIdentifier: 'a'}]);
        }
        return reply({processTokens: [{processIdentifier: 7}]});
      });
      const service = new TestAppService(fake);

      const [apps, procs] = await Promise.all([service.listApps(), service.listProcesses()]);

      assert.deepStrictEqual(apps, [{bundleIdentifier: 'a'}]);
      assert.deepStrictEqual(procs, [{processIdentifier: 7}]);
      assert.strictEqual(fake.sentBodies.length, 2);
    });
  });

  describe('close', function () {
    it('closes the active transport', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps();
      await service.close();

      assert.strictEqual(fake.closeCalls, 1);
    });
  });
});
