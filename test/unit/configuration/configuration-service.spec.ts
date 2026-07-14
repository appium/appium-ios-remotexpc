import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {expect} from 'chai';

import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary, XPCValue} from '../../../src/lib/types.js';
import {ConfigurationService} from '../../../src/services/ios/configuration/index.js';

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

class TestConfigurationService extends ConfigurationService {
  constructor(readonly fake: FakeTransport) {
    super('test-udid');
  }

  protected async createTransport(): Promise<any> {
    return this.fake;
  }
}

function actionId(body: XPCDictionary): string {
  return body['CoreDevice.actionIdentifier'] as string;
}

function input(body: XPCDictionary): XPCDictionary {
  return body['CoreDevice.input'] as XPCDictionary;
}

function reply(output: XPCValue): XPCDictionary {
  return {'CoreDevice.output': output};
}

/** Awaits `promise` and returns the rejection error, failing if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('ConfigurationService', function () {
  it('getUserInterfaceStyle reads output.style', async function () {
    const fake = new FakeTransport(() => reply({style: 'dark'}));
    const service = new TestConfigurationService(fake);

    const style = await service.getUserInterfaceStyle();

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.getuserinterfacestyle');
    // Action-only invocations carry no feature identifier.
    expect(fake.sentBodies[0]['CoreDevice.featureIdentifier']).to.equal(undefined);
    expect(style).to.equal('dark');
  });

  it('setUserInterfaceStyle sends the style input', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setUserInterfaceStyle('light');

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.setuserinterfacestyle');
    expect(input(fake.sentBodies[0])).to.deep.equal({style: 'light'});
  });

  it('setUserInterfaceStyle rejects an invalid style without sending a message', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    expect(await rejection(service.setUserInterfaceStyle('sepia' as any))).to.be.instanceOf(TypeError);
    expect(fake.sentBodies).to.have.length(0);
  });

  it('setReduceMotion sends the enabled flag', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setReduceMotion(true);

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.setreducemotion');
    expect(input(fake.sentBodies[0])).to.deep.equal({reduceMotion: {enabled: true}});
  });

  it('getReduceTransparency reads the nested enabled flag', async function () {
    const fake = new FakeTransport(() => reply({reduceTransparency: {enabled: true}}));
    const service = new TestConfigurationService(fake);

    const enabled = await service.getReduceTransparency();

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.getreducetransparency');
    expect(enabled).to.equal(true);
  });

  it('getDeviceTextSize returns the first size key', async function () {
    const fake = new FakeTransport(() => reply({textSize: {size: {large: {}}}}));
    const service = new TestConfigurationService(fake);

    const size = await service.getDeviceTextSize();

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.getdevicetextsize');
    expect(size).to.equal('large');
  });

  it('setDeviceTextSize encodes the size as an enum-style single-key dict', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setDeviceTextSize('extraLarge');

    expect(input(fake.sentBodies[0])).to.deep.equal({textSize: {size: {extraLarge: {}}}});
  });

  it('getColorFilter returns the colorFilter dict', async function () {
    const fake = new FakeTransport(() => reply({colorFilter: {enabled: true, filterType: {name: 'Protanopia'}}}));
    const service = new TestConfigurationService(fake);

    const state = await service.getColorFilter();

    expect(state.enabled).to.equal(true);
    expect(state.filterType?.name).to.equal('Protanopia');
  });

  it('setColorFilter(true) requires a filterType', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    expect(await rejection(service.setColorFilter(true))).to.be.instanceOf(TypeError);
    expect(fake.sentBodies).to.have.length(0);
  });

  it('setColorFilter(true, ...) sends filterType and Float32-quantized intensity', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setColorFilter(true, {filterType: 'Protanopia', intensity: 0.5});

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.setcolorfilter');
    const filter = input(fake.sentBodies[0]).colorFilter as XPCDictionary;
    expect(filter.enabled).to.equal(true);
    expect(filter.filterType).to.deep.equal({name: 'Protanopia'});
    expect(filter.intensity).to.equal(0.5);
  });

  it('setColorFilter(false) sends only enabled=false', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setColorFilter(false, {filterType: 'Protanopia'});

    expect(input(fake.sentBodies[0])).to.deep.equal({colorFilter: {enabled: false}});
  });

  it('setLiquidGlassOpacity quantizes to Float32 and nests under configuration', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setLiquidGlassOpacity(0.55);

    expect(actionId(fake.sentBodies[0])).to.equal('com.apple.coredevice.action.setliquidglassconfiguration');
    const config = input(fake.sentBodies[0]).configuration as XPCDictionary;
    expect(config.opacity).to.be.a('number');
    expect(config.opacity as number).to.be.closeTo(0.55, 1e-6);
    // Round-trips exactly through IEEE-754 binary32.
    expect(config.opacity).to.equal(Math.fround(0.55));
  });

  it('setLiquidGlassOpacity rejects out-of-range values without sending', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    expect(await rejection(service.setLiquidGlassOpacity(1.5))).to.be.instanceOf(RangeError);
    expect(fake.sentBodies).to.have.length(0);
  });

  it('closes the active transport', async function () {
    const fake = new FakeTransport(() => reply({style: 'dark'}));
    const service = new TestConfigurationService(fake);

    await service.getUserInterfaceStyle();
    await service.close();

    expect(fake.closeCalls).to.equal(1);
  });
});
