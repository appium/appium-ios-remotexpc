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
  /**
   * Device-reported orientation-lock flag. Do **not** rely on this to detect
   * Control Center Rotation Lock: on iOS 26.5 it was observed to stay `false`
   * even while that lock was active and preventing rotation. To tell whether a
   * rotation was actually applied, compare {@link currentDeviceOrientation}
   * before and after {@link DeviceControlService.rotate}.
   */
  currentDeviceOrientationLocked?: boolean;
  [key: string]: unknown;
}

/**
 * Result of {@link DeviceControlService.getOrientation}: the device's current
 * orientation together with an empirically-determined rotation-lock flag.
 */
export interface DeviceOrientationInfo {
  /**
   * Current device orientation, e.g. `'portrait'`, `'landscapeLeft'`. Because
   * the probe restores the device, this equals the orientation the device had
   * before {@link DeviceControlService.getOrientation} was called.
   */
  orientation?: string;
  /** The most recent non-flat orientation (ignores face-up/face-down). */
  nonFlatOrientation?: string;
  /**
   * Whether device rotation is currently locked (e.g. Control Center Rotation
   * Lock). Determined by attempting a rotation and reverting it: `true` when the
   * attempted rotation left the orientation unchanged.
   */
  locked: boolean;
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
   * for `'left'`).
   *
   * Rotation only applies when Control Center Rotation Lock is off. When the
   * lock is on the call still resolves normally (it does **not** throw), but the
   * returned {@link DeviceOrientationState.currentDeviceOrientation} is
   * unchanged — the only reliable signal that rotation was blocked. There is no
   * read-only request to query orientation in advance; the device rejects any
   * non-rotate message by resetting the connection.
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

  /**
   * Probes the device's current orientation and whether rotation is locked,
   * leaving the device's final orientation unchanged.
   *
   * CoreDevice exposes no read-only orientation query, and the device-reported
   * {@link DeviceOrientationState.currentDeviceOrientationLocked} flag is
   * unreliable. This method therefore rotates the device one 90° step and
   * immediately reverts it:
   *
   * - If the orientation changed, rotation is **unlocked**.
   * - If it stayed the same, rotation is **locked**.
   *
   * The two rotations cancel out, so the device ends where it began — though it
   * does briefly rotate and rotate back while the probe runs.
   *
   * @example
   * ```ts
   * const {orientation, locked} = await deviceControl.getOrientation();
   * console.log(`device is ${orientation}${locked ? ' (rotation locked)' : ''}`);
   * ```
   */
  async getOrientation(): Promise<DeviceOrientationInfo> {
    const rotated = await this.rotate('left');
    const restored = await this.rotate('right');
    return {
      orientation: restored.currentDeviceOrientation,
      nonFlatOrientation: restored.currentDeviceNonFlatOrientation,
      locked: rotated.currentDeviceOrientation === restored.currentDeviceOrientation,
    };
  }
}

export default DeviceControlService;
