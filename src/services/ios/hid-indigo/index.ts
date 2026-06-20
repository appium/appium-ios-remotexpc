import { Http2Constants, XpcConstants } from '../../../lib/remote-xpc/constants.js';
import { RemoteXpcFramedTransport } from '../../../lib/remote-xpc/remote-xpc-framed-transport.js';
import { encodeMessage } from '../../../lib/remote-xpc/xpc-protocol.js';
import type { XPCDictionary } from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_DELIVERY_DELAY_MS = 100;

export const HID_BUTTON_STATE_DOWN = 1;
export const HID_BUTTON_STATE_UP = 2;
export const HID_BUTTON_STATE_CANCELED = 3;

export type HidButtonState = 'down' | 'up' | 'canceled';

export interface HidButtonEventOptions {
  usagePage: number;
  usageCode: number;
  state: HidButtonState;
}

export interface HidButtonPressOptions {
  holdSeconds?: number;
}

const BUTTON_STATES: Record<HidButtonState, number> = {
  down: HID_BUTTON_STATE_DOWN,
  up: HID_BUTTON_STATE_UP,
  canceled: HID_BUTTON_STATE_CANCELED,
};

const NAMED_BUTTONS = {
  home: { usagePage: 0x0c, usageCode: 0x40, holdSeconds: 0.05 },
  lock: { usagePage: 0x0c, usageCode: 0x30, holdSeconds: 0.5 },
  'volume-up': { usagePage: 0x0c, usageCode: 0xe9, holdSeconds: 0.05 },
  'volume-down': { usagePage: 0x0c, usageCode: 0xea, holdSeconds: 0.05 },
  mute: { usagePage: 0x0c, usageCode: 0xe2, holdSeconds: 0.05 },
  siri: { usagePage: 0x0c, usageCode: 0xcf, holdSeconds: 1 },
} as const;

export type HidButtonName = keyof typeof NAMED_BUTTONS;

/**
 * CoreDevice HID Indigo service for dispatching hardware button events.
 */
export class HidIndigoService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.hid.indigo';

  private transport: RemoteXpcFramedTransport | null = null;
  private nextMessageId = 1;

  async pressButton(
    name: HidButtonName,
    options: HidButtonPressOptions = {},
  ): Promise<void> {
    const button = NAMED_BUTTONS[name];
    await this.pressRawButton(button.usagePage, button.usageCode, {
      holdSeconds: options.holdSeconds ?? button.holdSeconds,
    });
  }

  async pressRawButton(
    usagePage: number,
    usageCode: number,
    options: HidButtonPressOptions = {},
  ): Promise<void> {
    await this.sendButton({ usagePage, usageCode, state: 'down' });
    await delay((options.holdSeconds ?? 0.05) * 1000);
    await this.sendButton({ usagePage, usageCode, state: 'up' });
    await delay(CLOSE_DELIVERY_DELAY_MS);
  }

  async sendButton(options: HidButtonEventOptions): Promise<void> {
    const transport = await this.getTransport();
    transport.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT,
        id: this.nextMessageId++,
        body: buildButtonEvent(options),
      }),
      Http2Constants.ROOT_CHANNEL,
    );
  }

  async close(): Promise<void> {
    if (!this.transport) {
      return;
    }

    await this.transport.close();
    this.transport = null;
  }

  protected async createTransport(): Promise<RemoteXpcFramedTransport> {
    const transport = new RemoteXpcFramedTransport(
      await this.resolveServiceAddress(HidIndigoService.RSD_SERVICE_NAME),
    );
    await transport.connect({ timeoutMs: CONNECT_TIMEOUT_MS });
    return transport;
  }

  private async getTransport(): Promise<RemoteXpcFramedTransport> {
    if (!this.transport?.isConnected) {
      this.transport = await this.createTransport();
    }
    return this.transport;
  }
}

function buildButtonEvent(options: HidButtonEventOptions): XPCDictionary {
  return {
    messageType: 'IndigoButtonEvent',
    payload: {
      state: BigInt(BUTTON_STATES[options.state]),
      usagePage: BigInt(options.usagePage),
      usageCode: BigInt(options.usageCode),
    },
    featureIdentifier: 'com.apple.coredevice.feature.remote.hid.button',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
