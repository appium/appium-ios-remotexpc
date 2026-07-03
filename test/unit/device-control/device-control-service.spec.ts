import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {expect} from 'chai';

import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';
import {DeviceControlService} from '../../../src/services/ios/device-control/index.js';

type Responder = (sentBody: XPCDictionary) => XPCDictionary | null;

const ORIENTATION_FEATURE = 'com.apple.coredevice.feature.remote.devicecontrol.orientation';

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

class TestDeviceControlService extends DeviceControlService {
  constructor(readonly fake: FakeTransport) {
    super('test-udid');
  }

  protected async createTransport(): Promise<any> {
    return this.fake;
  }
}

describe('DeviceControlService', function () {
  it('rotate("left") sends a raw OrientationRequest and returns the reply', async function () {
    const orientation = {
      currentDeviceOrientation: 'landscapeLeft',
      currentDeviceNonFlatOrientation: 'landscapeLeft',
      currentDeviceOrientationLocked: false,
    };
    const fake = new FakeTransport(() => orientation);
    const service = new TestDeviceControlService(fake);

    const result = await service.rotate('left');

    expect(fake.sentBodies[0]).to.deep.equal({
      featureIdentifier: ORIENTATION_FEATURE,
      messageType: 'OrientationRequest',
      payload: {rotate: {_0: 'left'}},
    });
    // Raw message — not wrapped in the CoreDevice invocation envelope.
    expect(fake.sentBodies[0]).to.not.have.property('CoreDevice.featureIdentifier');
    expect(result).to.deep.equal(orientation);
  });

  it('rotate("right") sends the clockwise direction', async function () {
    const fake = new FakeTransport(() => ({
      currentDeviceOrientation: 'landscapeRight',
    }));
    const service = new TestDeviceControlService(fake);

    await service.rotate('right');

    expect((fake.sentBodies[0].payload as XPCDictionary).rotate).to.deep.equal({
      _0: 'right',
    });
  });

  it('rejects an invalid direction without sending anything', async function () {
    const fake = new FakeTransport(() => ({}));
    const service = new TestDeviceControlService(fake);

    let caught: unknown;
    try {
      // @ts-expect-error runtime guard is under test
      await service.rotate('up');
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(TypeError);
    expect(fake.sentBodies).to.have.length(0);
  });

  it('closes the active transport', async function () {
    const fake = new FakeTransport(() => ({
      currentDeviceOrientation: 'portrait',
    }));
    const service = new TestDeviceControlService(fake);

    await service.rotate('left');
    await service.close();

    expect(fake.closeCalls).to.equal(1);
  });
});
