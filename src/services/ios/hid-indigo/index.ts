import {
  Http2Constants,
  XpcConstants,
} from '../../../lib/remote-xpc/constants.js';
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
  pressCount?: number;
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
    options?: HidButtonPressOptions,
  ): Promise<void>;
  async pressButton(
    usagePage: number,
    usageCode: number,
    options?: HidButtonPressOptions,
  ): Promise<void>;
  async pressButton(
    arg1: HidButtonName | number,
    arg2?: HidButtonPressOptions | number,
    arg3?: HidButtonPressOptions,
  ): Promise<void> {
    const { usagePage, usageCode, options } = resolveButtonArgs(
      arg1,
      arg2,
      arg3,
    );
    const pressCount = validatePressCount(options.pressCount ?? 1);
    const defaultHoldSeconds =
      typeof arg1 === 'string'
        ? NAMED_BUTTONS[arg1 as HidButtonName].holdSeconds
        : 0.05;
    const holdMs = (options.holdSeconds ?? defaultHoldSeconds) * 1000;

    for (let i = 0; i < pressCount; i++) {
      await this.sendButton({ usagePage, usageCode, state: 'down' });
      await delay(holdMs);
      await this.sendButton({ usagePage, usageCode, state: 'up' });
      await delay(CLOSE_DELIVERY_DELAY_MS);
    }
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

function resolveButtonArgs(
  arg1: HidButtonName | number,
  arg2?: HidButtonPressOptions | number,
  arg3?: HidButtonPressOptions,
): {
  usagePage: number;
  usageCode: number;
  options: HidButtonPressOptions;
} {
  if (
    typeof arg1 === 'string' &&
    (arg2 === undefined || typeof arg2 !== 'number')
  ) {
    const button = NAMED_BUTTONS[arg1 as HidButtonName];
    return {
      usagePage: button.usagePage,
      usageCode: button.usageCode,
      options: (arg2 as HidButtonPressOptions | undefined) ?? {},
    };
  }

  if (typeof arg1 === 'number' && typeof arg2 === 'number') {
    return {
      usagePage: arg1,
      usageCode: arg2,
      options: arg3 ?? {},
    };
  }

  throw new Error(
    'pressButton expects either a button name plus options, or usagePage and usageCode plus options',
  );
}

function validatePressCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('pressCount must be a positive integer');
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
