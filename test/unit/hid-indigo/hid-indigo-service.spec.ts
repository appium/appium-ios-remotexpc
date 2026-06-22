import { expect } from 'chai';

import { decodeMessage } from '../../../src/lib/remote-xpc/xpc-protocol.js';
import {
  HID_BUTTON_STATE_DOWN,
  HID_BUTTON_STATE_UP,
  HidIndigoService,
} from '../../../src/services/ios/hid-indigo/index.js';

class TestHidIndigoService extends HidIndigoService {
  readonly sentPayloads: Buffer[] = [];
  closeCalls = 0;

  protected async createTransport(): Promise<any> {
    return {
      isConnected: true,
      sendDataFrame: (payload: Buffer): void => {
        this.sentPayloads.push(payload);
      },
      close: async (): Promise<void> => {
        this.closeCalls++;
      },
    };
  }
}

describe('HidIndigoService', function () {
  it('sends home button down and up events', async function () {
    const service = new TestHidIndigoService('test-udid');

    await service.pressButton('home', { holdSeconds: 0 });

    expect(service.sentPayloads).to.have.length(2);
    expect(decodeBody(service.sentPayloads[0])).to.deep.equal({
      featureIdentifier: 'com.apple.coredevice.feature.remote.hid.button',
      messageType: 'IndigoButtonEvent',
      payload: {
        state: HID_BUTTON_STATE_DOWN,
        usageCode: 0x40,
        usagePage: 0x0c,
      },
    });
    expect(decodeBody(service.sentPayloads[1])).to.deep.equal({
      featureIdentifier: 'com.apple.coredevice.feature.remote.hid.button',
      messageType: 'IndigoButtonEvent',
      payload: {
        state: HID_BUTTON_STATE_UP,
        usageCode: 0x40,
        usagePage: 0x0c,
      },
    });
  });

  it('sends multiple press sequences when pressCount is set', async function () {
    const service = new TestHidIndigoService('test-udid');

    await service.pressButton('home', {
      holdSeconds: 0,
      pressCount: 2,
    });

    expect(service.sentPayloads).to.have.length(4);
  });

  it('closes the active transport', async function () {
    const service = new TestHidIndigoService('test-udid');

    await service.sendButton({
      usagePage: 0x0c,
      usageCode: 0xe9,
      state: 'down',
    });
    await service.close();

    expect(service.closeCalls).to.equal(1);
  });
});

function decodeBody(payload: Buffer): Record<string, unknown> {
  const { message } = decodeMessage(payload);
  return message.body as Record<string, unknown>;
}
