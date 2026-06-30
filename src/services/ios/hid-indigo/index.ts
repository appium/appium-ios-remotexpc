import type {XPCDictionary} from '../../../lib/types.js';
import {CoreDeviceService} from '../core-device/core-device-service.js';

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
  home: {usagePage: 0x0c, usageCode: 0x40, holdSeconds: 0.05},
  lock: {usagePage: 0x0c, usageCode: 0x30, holdSeconds: 0.5},
  'volume-up': {usagePage: 0x0c, usageCode: 0xe9, holdSeconds: 0.05},
  'volume-down': {usagePage: 0x0c, usageCode: 0xea, holdSeconds: 0.05},
  mute: {usagePage: 0x0c, usageCode: 0xe2, holdSeconds: 0.05},
  siri: {usagePage: 0x0c, usageCode: 0xcf, holdSeconds: 1},
} as const;

export type HidButtonName = keyof typeof NAMED_BUTTONS;

/**
 * CoreDevice HID Indigo service for dispatching hardware button events.
 */
export class HidIndigoService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.hid.indigo';

  constructor(udid: string) {
    super(udid, HidIndigoService.RSD_SERVICE_NAME);
  }

  async pressButton(name: HidButtonName, options?: HidButtonPressOptions): Promise<void>;
  async pressButton(usagePage: number, usageCode: number, options?: HidButtonPressOptions): Promise<void>;
  async pressButton(
    arg1: HidButtonName | number,
    arg2?: HidButtonPressOptions | number,
    arg3?: HidButtonPressOptions,
  ): Promise<void> {
    const {usagePage, usageCode, options} = resolveButtonArgs(arg1, arg2, arg3);
    const pressCount = validatePressCount(options.pressCount ?? 1);
    const defaultHoldSeconds = typeof arg1 === 'string' ? NAMED_BUTTONS[arg1 as HidButtonName].holdSeconds : 0.05;
    const holdMs = (options.holdSeconds ?? defaultHoldSeconds) * 1000;

    for (let i = 0; i < pressCount; i++) {
      await this.sendButton({usagePage, usageCode, state: 'down'});
      await delay(holdMs);
      await this.sendButton({usagePage, usageCode, state: 'up'});
      await delay(CLOSE_DELIVERY_DELAY_MS);
    }
  }

  async sendButton(options: HidButtonEventOptions): Promise<void> {
    await this.send(buildButtonEvent(options));
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
  if (typeof arg1 === 'string' && (arg2 === undefined || typeof arg2 !== 'number')) {
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

  throw new Error('pressButton expects either a button name plus options, or usagePage and usageCode plus options');
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
