import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import {
  type CoreDeviceInvokeOptions,
  CoreDeviceService,
} from '../core-device/core-device-service.js';

const FEATURE_GET_DEVICE_INFO = 'com.apple.coredevice.feature.getdeviceinfo';
const FEATURE_GET_DISPLAY_INFO = 'com.apple.coredevice.feature.getdisplayinfo';
const FEATURE_GET_LOCK_STATE = 'com.apple.coredevice.feature.getlockstate';
const FEATURE_QUERY_MOBILEGESTALT =
  'com.apple.coredevice.feature.querymobilegestalt';

/** Device attributes returned by {@link CoreDeviceInfoService.getDeviceInfo}. */
export interface CoreDeviceAttributes {
  [key: string]: unknown;
}

/** Display attributes returned by {@link CoreDeviceInfoService.getDisplayInfo}. */
export interface CoreDeviceDisplayInfo {
  [key: string]: unknown;
}

/** Lock state returned by {@link CoreDeviceInfoService.getLockState}. */
export interface CoreDeviceLockState {
  [key: string]: unknown;
}

/**
 * CoreDevice DeviceInfo — query device identity and state over RemoteXPC
 * (`com.apple.coredevice.deviceinfo`), the backend used by `xcrun devicectl`.
 *
 * Complementary to the DVT `DeviceInfo` instrument (which exposes Instruments /
 * profiling data over DTX): this service is the only source here for display
 * geometry, lock state, and MobileGestalt values.
 *
 * @example
 * ```ts
 * const deviceInfo = await Services.startCoreDeviceInfoService(udid);
 * try {
 *   const display = await deviceInfo.getDisplayInfo();
 *   const locked = await deviceInfo.getLockState();
 * } finally {
 *   await deviceInfo.close();
 * }
 * ```
 */
export class CoreDeviceInfoService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.deviceinfo';

  constructor(udid: string) {
    super(udid, CoreDeviceInfoService.RSD_SERVICE_NAME);
  }

  /**
   * Returns general device attributes (OS version, build, hardware identity,
   * device class, …).
   */
  async getDeviceInfo(
    options: CoreDeviceInvokeOptions = {},
  ): Promise<CoreDeviceAttributes> {
    return asDict(await this.invoke(FEATURE_GET_DEVICE_INFO, {}, options));
  }

  /**
   * Returns display attributes (dimensions, scale, …). Useful for coordinate
   * mapping and screenshot geometry.
   */
  async getDisplayInfo(
    options: CoreDeviceInvokeOptions = {},
  ): Promise<CoreDeviceDisplayInfo> {
    return asDict(await this.invoke(FEATURE_GET_DISPLAY_INFO, {}, options));
  }

  /**
   * Returns the device lock state (e.g. whether the screen is locked and
   * whether a passcode is set).
   *
   * ⚠️ Not implemented on every iOS version: some devices reject this feature
   * with `CoreDevice.ActionError 2` ("is not implemented"), surfaced here as a
   * {@link CoreDeviceError}.
   */
  async getLockState(
    options: CoreDeviceInvokeOptions = {},
  ): Promise<CoreDeviceLockState> {
    return asDict(await this.invoke(FEATURE_GET_LOCK_STATE, {}, options));
  }

  /**
   * Queries MobileGestalt values for the given keys, returning a map of the
   * results.
   *
   * ⚠️ May be gated: Apple restricts gestalt queries to specific (personalized)
   * device contexts, so on a normal device this can return an error or empty
   * values. Pass `timeoutMs` via `options` to bound the wait.
   */
  async queryMobileGestalt(
    keys: string[],
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCDictionary> {
    return asDict(
      await this.invoke(FEATURE_QUERY_MOBILEGESTALT, { keys }, options),
    );
  }
}

function asDict(value: XPCValue): XPCDictionary {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as XPCDictionary;
  }
  return {};
}

export default CoreDeviceInfoService;
