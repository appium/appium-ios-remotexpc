import {EventEmitter} from 'node:events';
import {constants as osConstants} from 'node:os';
import {describe, it} from 'node:test';

import {expect} from 'chai';

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
      expect(sent['CoreDevice.CoreDeviceDDIProtocolVersion']).to.equal(2);
      expect(sent['CoreDevice.coreDeviceVersion']).to.deep.equal({
        components: [629, 3],
        originalComponentsCount: 2,
        stringValue: '629.3',
      });
      expect(sent['CoreDevice.featureIdentifier']).to.equal('com.apple.coredevice.feature.listapps');
      expect(sent['CoreDevice.action']).to.deep.equal({});
      expect(sent['CoreDevice.deviceIdentifier']).to.be.a('string');
      expect(sent['CoreDevice.invocationIdentifier']).to.be.a('string');
      // Each invocation gets a fresh identifier.
      expect(sent['CoreDevice.deviceIdentifier']).to.not.equal(sent['CoreDevice.invocationIdentifier']);
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

      expect(input(fake.sentBodies[0])).to.deep.equal({
        includeAppClips: true,
        includeRemovableApps: true,
        includeHiddenApps: true,
        includeInternalApps: true,
        includeDefaultApps: true,
        requireContainerAccess: false,
        includeAppGroupIdentifiers: false,
        includeContainerPaths: false,
      });
      expect(result).to.deep.equal(apps);
    });

    it('honors explicit include options', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps({includeHiddenApps: false});

      expect(input(fake.sentBodies[0]).includeHiddenApps).to.equal(false);
      expect(input(fake.sentBodies[0]).includeAppClips).to.equal(true);
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
      expect(sent.requireContainerAccess).to.equal(true);
      expect(sent.includeAppGroupIdentifiers).to.equal(true);
      expect(sent.includeContainerPaths).to.equal(true);
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
      expect(sentInput.applicationSpecifier).to.deep.equal({
        bundleIdentifier: {_0: 'com.apple.Preferences'},
      });
      const opts = sentInput.options as XPCDictionary;
      expect(opts.arguments).to.deep.equal(['--foo']);
      expect(opts.environmentVariables).to.deep.equal({A: 'B'});
      expect(opts.terminateExisting).to.equal(true);
      expect(opts.startStopped).to.equal(false);
      expect(opts.user).to.deep.equal({shortName: 'mobile'});
      // platformSpecificOptions is a serialized plist (XPC data -> Buffer).
      expect(Buffer.isBuffer(opts.platformSpecificOptions)).to.equal(true);
      expect((opts.platformSpecificOptions as Buffer).toString('utf8')).to.contain('plist');

      expect(launched.processIdentifier).to.equal(99);
      expect(launched.processToken).to.deep.equal({processIdentifier: 99});
    });

    it('defaults arguments/environment and allows disabling terminateExisting', async function () {
      const fake = new FakeTransport(() => reply({processToken: {}}));
      const service = new TestAppService(fake);

      await service.launchApplication('com.x', {terminateExisting: false});

      const opts = input(fake.sentBodies[0]).options as XPCDictionary;
      expect(opts.arguments).to.deep.equal([]);
      expect(opts.environmentVariables).to.deep.equal({});
      expect(opts.terminateExisting).to.equal(false);
    });
  });

  describe('listProcesses', function () {
    it('returns the processTokens array from the output', async function () {
      const tokens = [{processIdentifier: 1}, {processIdentifier: 42, executableURL: {relative: '/x'}}];
      const fake = new FakeTransport(() => reply({processTokens: tokens}));
      const service = new TestAppService(fake);

      const result = await service.listProcesses();

      expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.listprocesses');
      expect(result).to.deep.equal(tokens);
    });
  });

  describe('sendSignalToProcess', function () {
    it('sends the pid and signal as the input', async function () {
      const fake = new FakeTransport(() => reply({}));
      const service = new TestAppService(fake);

      await service.sendSignalToProcess(123, osConstants.signals.SIGKILL);

      expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.sendsignaltoprocess');
      expect(input(fake.sentBodies[0])).to.deep.equal({
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

      expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.uninstallapp');
      expect(input(fake.sentBodies[0])).to.deep.equal({
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
      expect(caught).to.be.instanceOf(CoreDeviceError);
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
      expect(caught).to.be.instanceOf(CoreDeviceError);
      const message = (caught as Error).message;
      expect(message).to.contain('is not installed');
      expect(message).to.contain('com.apple.dt.CoreDeviceError');
      expect(message).to.contain('10002');
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
      expect(caught).to.be.instanceOf(CoreDeviceError);
      expect((caught as Error).message).to.contain('timed out');
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

      expect(apps).to.deep.equal([{bundleIdentifier: 'a'}]);
      expect(procs).to.deep.equal([{processIdentifier: 7}]);
      expect(fake.sentBodies).to.have.length(2);
    });
  });

  describe('close', function () {
    it('closes the active transport', async function () {
      const fake = new FakeTransport(() => reply([]));
      const service = new TestAppService(fake);

      await service.listApps();
      await service.close();

      expect(fake.closeCalls).to.equal(1);
    });
  });
});
