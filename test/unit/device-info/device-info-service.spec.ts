import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {expect} from 'chai';

import {CoreDeviceError} from '../../../src/index.js';
import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary, XPCValue} from '../../../src/lib/types.js';
import {CoreDeviceInfoService} from '../../../src/services/ios/device-info/index.js';

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

class TestDeviceInfoService extends CoreDeviceInfoService {
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

describe('CoreDeviceInfoService', function () {
  it('getDeviceInfo invokes getdeviceinfo and returns the output', async function () {
    const out = {cpuCount: {logicalCores: 6}};
    const fake = new FakeTransport(() => reply(out));
    const service = new TestDeviceInfoService(fake);

    const result = await service.getDeviceInfo();

    expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.getdeviceinfo');
    expect(input(fake.sentBodies[0])).to.deep.equal({});
    expect(result).to.deep.equal(out);
  });

  it('getDisplayInfo invokes getdisplayinfo and returns the output', async function () {
    const out = {displays: [{primary: true, nativeSize: [828, 1792]}]};
    const fake = new FakeTransport(() => reply(out));
    const service = new TestDeviceInfoService(fake);

    const result = await service.getDisplayInfo();

    expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.getdisplayinfo');
    expect(result).to.deep.equal(out);
  });

  it('getLockState invokes getlockstate', async function () {
    const fake = new FakeTransport(() => reply({locked: false}));
    const service = new TestDeviceInfoService(fake);

    const result = await service.getLockState();

    expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.getlockstate');
    expect(result).to.deep.equal({locked: false});
  });

  it('queryMobileGestalt sends the keys and returns the output', async function () {
    const fake = new FakeTransport(() => reply({ProductType: 'iPhone12,1'}));
    const service = new TestDeviceInfoService(fake);

    const result = await service.queryMobileGestalt(['ProductType']);

    expect(feature(fake.sentBodies[0])).to.equal('com.apple.coredevice.feature.querymobilegestalt');
    expect(input(fake.sentBodies[0])).to.deep.equal({keys: ['ProductType']});
    expect(result).to.deep.equal({ProductType: 'iPhone12,1'});
  });

  it('surfaces a device ActionError (unimplemented / gated feature)', async function () {
    const fake = new FakeTransport(() => ({
      'CoreDevice.error': {
        domain: 'CoreDevice.ActionError',
        code: 2,
        userInfo: {
          NSLocalizedDescription: "Action 'com.apple.coredevice.feature.getlockstate' is not implemented.",
        },
      },
    }));
    const service = new TestDeviceInfoService(fake);

    let caught: unknown;
    try {
      await service.getLockState();
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(CoreDeviceError);
    const message = (caught as Error).message;
    expect(message).to.contain('not implemented');
    expect(message).to.contain('CoreDevice.ActionError');
  });

  it('closes the active transport', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestDeviceInfoService(fake);

    await service.getDeviceInfo();
    await service.close();

    expect(fake.closeCalls).to.equal(1);
  });
});
