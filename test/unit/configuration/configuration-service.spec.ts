import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {CoreDeviceError} from '../../../src/index.js';
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

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.getuserinterfacestyle');
    // Action-only invocations carry no feature identifier.
    assert.strictEqual(fake.sentBodies[0]['CoreDevice.featureIdentifier'], undefined);
    assert.strictEqual(style, 'dark');
  });

  it('setUserInterfaceStyle sends the style input', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setUserInterfaceStyle('light');

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.setuserinterfacestyle');
    assert.deepStrictEqual(input(fake.sentBodies[0]), {style: 'light'});
  });

  it('setUserInterfaceStyle rejects an empty/non-string style without sending a message', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    assert.ok((await rejection(service.setUserInterfaceStyle('' as any))) instanceof TypeError);
    assert.ok((await rejection(service.setUserInterfaceStyle(undefined as any))) instanceof TypeError);
    assert.strictEqual(fake.sentBodies.length, 0);
  });

  it('setUserInterfaceStyle forwards an unknown-but-non-empty style to the device (forward-compat)', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    // A future OS style must not be blocked client-side; let the device decide.
    await service.setUserInterfaceStyle('auto');

    assert.deepStrictEqual(input(fake.sentBodies[0]), {style: 'auto'});
  });

  it('getUserInterfaceStyle passes an unknown string through (forward-compat)', async function () {
    const fake = new FakeTransport(() => reply({style: 'auto'}));
    const service = new TestConfigurationService(fake);

    assert.strictEqual(await service.getUserInterfaceStyle(), 'auto');
  });

  it('getUserInterfaceStyle throws on a missing/non-string style (malformed reply)', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    assert.ok((await rejection(service.getUserInterfaceStyle())) instanceof CoreDeviceError);
  });

  it('setReduceMotion sends the enabled flag', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setReduceMotion(true);

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.setreducemotion');
    assert.deepStrictEqual(input(fake.sentBodies[0]), {reduceMotion: {enabled: true}});
  });

  it('getReduceTransparency reads the nested enabled flag', async function () {
    const fake = new FakeTransport(() => reply({reduceTransparency: {enabled: true}}));
    const service = new TestConfigurationService(fake);

    const enabled = await service.getReduceTransparency();

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.getreducetransparency');
    assert.strictEqual(enabled, true);
  });

  it('getDeviceTextSize returns the first size key', async function () {
    const fake = new FakeTransport(() => reply({textSize: {size: {large: {}}}}));
    const service = new TestConfigurationService(fake);

    const size = await service.getDeviceTextSize();

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.getdevicetextsize');
    assert.strictEqual(size, 'large');
  });

  it('setDeviceTextSize encodes the size as an enum-style single-key dict', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setDeviceTextSize('extraLarge');

    assert.deepStrictEqual(input(fake.sentBodies[0]), {textSize: {size: {extraLarge: {}}}});
  });

  it('setDeviceTextSize rejects an unknown size without sending a message', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    assert.ok((await rejection(service.setDeviceTextSize('humongous' as any))) instanceof TypeError);
    assert.strictEqual(fake.sentBodies.length, 0);
  });

  it('getColorFilter returns the colorFilter dict', async function () {
    const fake = new FakeTransport(() => reply({colorFilter: {enabled: true, filterType: {name: 'Protanopia'}}}));
    const service = new TestConfigurationService(fake);

    const state = await service.getColorFilter();

    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.filterType?.name, 'Protanopia');
  });

  it('setColorFilter(true) requires a filterType', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    assert.ok((await rejection(service.setColorFilter(true))) instanceof TypeError);
    assert.strictEqual(fake.sentBodies.length, 0);
  });

  it('setColorFilter(true) rejects an unknown filterType without sending', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    // Case-sensitive: lowercase 'grayscale' is not a valid preset.
    assert.ok((await rejection(service.setColorFilter(true, {filterType: 'grayscale' as any}))) instanceof TypeError);
    assert.strictEqual(fake.sentBodies.length, 0);
  });

  it('getIncreaseContrast reads the nested enabled flag', async function () {
    const fake = new FakeTransport(() => reply({increaseContrast: {enabled: true}}));
    const service = new TestConfigurationService(fake);

    const enabled = await service.getIncreaseContrast();

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.getdeviceincreasecontrast');
    assert.strictEqual(enabled, true);
  });

  it('setColorFilter(true, ...) sends filterType and Float32-quantized intensity', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setColorFilter(true, {filterType: 'Protanopia', intensity: 0.5});

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.setcolorfilter');
    const filter = input(fake.sentBodies[0]).colorFilter as XPCDictionary;
    assert.strictEqual(filter.enabled, true);
    assert.deepStrictEqual(filter.filterType, {name: 'Protanopia'});
    assert.strictEqual(filter.intensity, 0.5);
  });

  it('setColorFilter(false) sends only enabled=false', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setColorFilter(false, {filterType: 'Protanopia'});

    assert.deepStrictEqual(input(fake.sentBodies[0]), {colorFilter: {enabled: false}});
  });

  it('setLiquidGlassOpacity quantizes to Float32 and nests under configuration', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    await service.setLiquidGlassOpacity(0.55);

    assert.strictEqual(actionId(fake.sentBodies[0]), 'com.apple.coredevice.action.setliquidglassconfiguration');
    const config = input(fake.sentBodies[0]).configuration as XPCDictionary;
    assert.ok(typeof config.opacity === 'number');
    assert.ok(Math.abs((config.opacity as number) - 0.55) <= 1e-6);
    // Round-trips exactly through IEEE-754 binary32.
    assert.strictEqual(config.opacity, Math.fround(0.55));
  });

  it('setLiquidGlassOpacity rejects out-of-range values without sending', async function () {
    const fake = new FakeTransport(() => reply({}));
    const service = new TestConfigurationService(fake);

    assert.ok((await rejection(service.setLiquidGlassOpacity(1.5))) instanceof RangeError);
    assert.strictEqual(fake.sentBodies.length, 0);
  });

  it('closes the active transport', async function () {
    const fake = new FakeTransport(() => reply({style: 'dark'}));
    const service = new TestConfigurationService(fake);

    await service.getUserInterfaceStyle();
    await service.close();

    assert.strictEqual(fake.closeCalls, 1);
  });
});
