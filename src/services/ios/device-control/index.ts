import type {XPCDictionary} from '../../../lib/types.js';
import {CoreDeviceService} from '../core-device/core-device-service.js';

const ORIENTATION_FEATURE = 'com.apple.coredevice.feature.remote.devicecontrol.orientation';

/** Rotation direction: `'left'` = counter-clockwise, `'right'` = clockwise. */
export type RotateDirection = 'left' | 'right';

/** Orientation state returned by {@link DeviceControlService.rotate}. */
export interface DeviceOrientationState {
  /**
   * The resulting device orientation, e.g. `'portrait'`, `'landscapeLeft'`,
   * `'portraitUpsideDown'`, `'landscapeRight'`.
   */
  currentDeviceOrientation?: string;
  /** The most recent non-flat orientation (ignores face-up/face-down). */
  currentDeviceNonFlatOrientation?: string;
  /** Whether iOS orientation lock is engaged (rotation still applies). */
  currentDeviceOrientationLocked?: boolean;
  [key: string]: unknown;
}

/**
 * CoreDevice device-control service (`com.apple.coredevice.devicecontrol`).
 *
 * Rotates the device 90° at a time. Unlike most CoreDevice services this uses a
 * raw message (no invocation envelope) whose `messageType` drives dispatch, sent
 * via the base {@link CoreDeviceService.sendReceive}.
 *
 * @example
 * ```ts
 * const deviceControl = await Services.startDeviceControlService(udid);
 * try {
 *   const state = await deviceControl.rotate('left'); // 90° counter-clockwise
 *   console.log(state.currentDeviceOrientation);
 * } finally {
 *   await deviceControl.close();
 * }
 * ```
 */
export class DeviceControlService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.devicecontrol';

  constructor(udid: string) {
    super(udid, DeviceControlService.RSD_SERVICE_NAME);
  }

  /**
   * Rotates the device 90° in `direction` (`'left'` = counter-clockwise,
   * `'right'` = clockwise) and returns the resulting orientation state.
   *
   * Four consecutive same-direction calls cycle a full turn
   * (`portrait → landscapeLeft → portraitUpsideDown → landscapeRight → portrait`
   * for `'left'`). Only works when iOS orientation lock is not set.
   */
  async rotate(direction: RotateDirection): Promise<DeviceOrientationState> {
    if (direction !== 'left' && direction !== 'right') {
      throw new TypeError(`direction must be 'left' or 'right', got '${String(direction)}'`);
    }
    const reply = await this.sendReceive({
      featureIdentifier: ORIENTATION_FEATURE,
      messageType: 'OrientationRequest',
      payload: {rotate: {_0: direction}},
    } as XPCDictionary);
    return reply as DeviceOrientationState;
  }
}

export default DeviceControlService;
