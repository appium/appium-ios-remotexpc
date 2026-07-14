import {asDictionary} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary} from '../../../lib/types.js';
import {type CoreDeviceInvokeOptions, CoreDeviceService} from '../core-device/core-device-service.js';

const ACTION = {
  GET_USER_INTERFACE_STYLE: 'com.apple.coredevice.action.getuserinterfacestyle',
  SET_USER_INTERFACE_STYLE: 'com.apple.coredevice.action.setuserinterfacestyle',
  SET_LIQUID_GLASS: 'com.apple.coredevice.action.setliquidglassconfiguration',
  GET_COLOR_FILTER: 'com.apple.coredevice.action.getcolorfilter',
  SET_COLOR_FILTER: 'com.apple.coredevice.action.setcolorfilter',
  GET_DEVICE_TEXT_SIZE: 'com.apple.coredevice.action.getdevicetextsize',
  SET_DEVICE_TEXT_SIZE: 'com.apple.coredevice.action.setdevicetextsize',
  GET_REDUCE_MOTION: 'com.apple.coredevice.action.getreducemotion',
  SET_REDUCE_MOTION: 'com.apple.coredevice.action.setreducemotion',
  SET_INCREASE_CONTRAST: 'com.apple.coredevice.action.setdeviceincreasecontrast',
  GET_SHOW_BORDERS: 'com.apple.coredevice.action.getshowborders',
  SET_SHOW_BORDERS: 'com.apple.coredevice.action.setshowborders',
  GET_REDUCE_TRANSPARENCY: 'com.apple.coredevice.action.getreducetransparency',
  SET_REDUCE_TRANSPARENCY: 'com.apple.coredevice.action.setreducetransparency',
} as const;

/** Device appearance: `'dark'` or `'light'`. */
export type UserInterfaceStyle = 'dark' | 'light';

/** Color-filter state returned by {@link ConfigurationService.getColorFilter}. */
export interface ColorFilterState {
  /** Whether the color filter is active. */
  enabled: boolean;
  /** Active filter preset (e.g. `'Protanopia'`); absent when disabled. */
  filterType?: {name?: string; [key: string]: unknown};
  /** Filter intensity 0.0..1.0; absent when disabled or unset. */
  intensity?: number;
  [key: string]: unknown;
}

/** Options for {@link ConfigurationService.setColorFilter}. */
export interface SetColorFilterOptions {
  /** Filter preset name (e.g. `'Protanopia'`). Required when enabling. */
  filterType?: string;
  /** Filter intensity 0.0..1.0. */
  intensity?: number;
}

/**
 * CoreDevice configuration service (`com.apple.coredevice.configuration`).
 *
 * Reads and writes the appearance and accessibility knobs that Xcode toggles
 * through the same service: dark/light mode, Dynamic Type text size, Reduce
 * Motion / Reduce Transparency / Increase Contrast, color filters, layout-debug
 * borders, and (iOS 26) liquid-glass opacity. This is the only path here that
 * reaches these settings — the DVT ConditionInducer does not expose them.
 *
 * Every method is a thin wrapper around a single `com.apple.coredevice.action.*`
 * invocation (no feature identifier, only an action identifier).
 *
 * @example
 * ```ts
 * const config = await Services.startConfigurationService(udid);
 * try {
 *   await config.setUserInterfaceStyle('dark');
 *   const style = await config.getUserInterfaceStyle(); // 'dark'
 * } finally {
 *   await config.close();
 * }
 * ```
 */
export class ConfigurationService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.configuration';

  constructor(udid: string) {
    super(udid, ConfigurationService.RSD_SERVICE_NAME);
  }

  /** Returns the active appearance — `'dark'` or `'light'`. */
  async getUserInterfaceStyle(options: CoreDeviceInvokeOptions = {}): Promise<UserInterfaceStyle> {
    const output = await this.action(ACTION.GET_USER_INTERFACE_STYLE, {}, options);
    return output.style as UserInterfaceStyle;
  }

  /** Sets the device appearance to `'dark'` or `'light'`. */
  async setUserInterfaceStyle(style: UserInterfaceStyle, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    if (style !== 'dark' && style !== 'light') {
      throw new TypeError(`style must be 'dark' or 'light', got '${String(style)}'`);
    }
    await this.action(ACTION.SET_USER_INTERFACE_STYLE, {style}, options);
  }

  /**
   * Sets the system liquid-glass opacity (iOS 26). `opacity` is range-checked to
   * `[0.0, 1.0]` and quantized to IEEE-754 binary32, matching what the device
   * daemon accepts on the wire.
   *
   * ⚠️ Device-gated, not just OS-gated: hardware that does not support Liquid
   * Glass customization rejects this with `com.apple.dt.CoreDeviceError 21035`
   * ("Liquid Glass configuration customization is not supported on this
   * device."), surfaced here as a {@link CoreDeviceError} — even on iOS 26.
   */
  async setLiquidGlassOpacity(opacity: number, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    if (!(opacity >= 0 && opacity <= 1)) {
      throw new RangeError(`opacity must be in [0.0, 1.0], got ${String(opacity)}`);
    }
    await this.action(ACTION.SET_LIQUID_GLASS, {configuration: {opacity: toFloat32(opacity)}}, options);
  }

  /**
   * Returns the color-filter state. When the filter is disabled only `enabled`
   * is present.
   */
  async getColorFilter(options: CoreDeviceInvokeOptions = {}): Promise<ColorFilterState> {
    const output = await this.action(ACTION.GET_COLOR_FILTER, {}, options);
    return (asDictionary(output.colorFilter) ?? {enabled: false}) as ColorFilterState;
  }

  /**
   * Sets the color filter. `filterType` is required when `enabled` is true
   * (e.g. `'Grayscale'`).
   *
   * ⚠️ `intensity` is device-gated: on some devices any `intensity` value is
   * rejected with `com.apple.dt.CoreDeviceError 21056` ("The color filter
   * intensity value is not valid."), surfaced here as a {@link CoreDeviceError}.
   * Omit it unless you know the target device accepts it. Some filter presets
   * (e.g. `'colorTint'`) also need extra parameters and will not enable from
   * `filterType` alone.
   */
  async setColorFilter(enabled: boolean, options: SetColorFilterOptions & CoreDeviceInvokeOptions = {}): Promise<void> {
    const {filterType, intensity, ...invokeOptions} = options;
    const colorFilter: XPCDictionary = {enabled};
    if (enabled) {
      if (filterType === undefined) {
        throw new TypeError('filterType is required when enabling the color filter');
      }
      colorFilter.filterType = {name: filterType};
      if (intensity !== undefined) {
        colorFilter.intensity = toFloat32(intensity);
      }
    }
    await this.action(ACTION.SET_COLOR_FILTER, {colorFilter}, invokeOptions);
  }

  /** Returns the Dynamic Type size name (e.g. `'medium'`, `'large'`). */
  async getDeviceTextSize(options: CoreDeviceInvokeOptions = {}): Promise<string | undefined> {
    const output = await this.action(ACTION.GET_DEVICE_TEXT_SIZE, {}, options);
    const size = asDictionary(asDictionary(output.textSize)?.size);
    return size ? Object.keys(size)[0] : undefined;
  }

  /** Sets the Dynamic Type size by name (`'medium'`, `'large'`, …). */
  async setDeviceTextSize(size: string, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    await this.action(ACTION.SET_DEVICE_TEXT_SIZE, {textSize: {size: {[size]: {}}}}, options);
  }

  /** Returns whether Reduce Motion is enabled. */
  async getReduceMotion(options: CoreDeviceInvokeOptions = {}): Promise<boolean> {
    return this.getEnabled(ACTION.GET_REDUCE_MOTION, 'reduceMotion', options);
  }

  /** Toggles Reduce Motion. */
  async setReduceMotion(enabled: boolean, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    await this.action(ACTION.SET_REDUCE_MOTION, {reduceMotion: {enabled}}, options);
  }

  /** Toggles Increase Contrast. The daemon exposes no symmetric getter. */
  async setIncreaseContrast(enabled: boolean, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    await this.action(ACTION.SET_INCREASE_CONTRAST, {increaseContrast: {enabled}}, options);
  }

  /** Returns whether the layout-debug borders overlay is enabled. */
  async getShowBorders(options: CoreDeviceInvokeOptions = {}): Promise<boolean> {
    return this.getEnabled(ACTION.GET_SHOW_BORDERS, 'showBorders', options);
  }

  /** Toggles the layout-debug borders overlay. */
  async setShowBorders(enabled: boolean, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    await this.action(ACTION.SET_SHOW_BORDERS, {showBorders: {enabled}}, options);
  }

  /** Returns whether Reduce Transparency is enabled. */
  async getReduceTransparency(options: CoreDeviceInvokeOptions = {}): Promise<boolean> {
    return this.getEnabled(ACTION.GET_REDUCE_TRANSPARENCY, 'reduceTransparency', options);
  }

  /** Toggles Reduce Transparency. */
  async setReduceTransparency(enabled: boolean, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    await this.action(ACTION.SET_REDUCE_TRANSPARENCY, {reduceTransparency: {enabled}}, options);
  }

  /** Invokes an action identifier (no feature identifier) and returns its output dict. */
  private async action(
    actionIdentifier: string,
    input: XPCDictionary,
    options: CoreDeviceInvokeOptions,
  ): Promise<XPCDictionary> {
    return asDictionary(await this.invoke(undefined, input, {...options, actionIdentifier})) ?? {};
  }

  /** Reads a `{ <key>: { enabled: bool } }`-shaped boolean knob. */
  private async getEnabled(actionIdentifier: string, key: string, options: CoreDeviceInvokeOptions): Promise<boolean> {
    const output = await this.action(actionIdentifier, {}, options);
    return asDictionary(output[key])?.enabled === true;
  }
}

/**
 * Rounds `value` through IEEE-754 binary32.
 * The daemon's Swift decoders reject float knobs whose low mantissa bits do not
 * fit in Float32; quantizing here produces a bit pattern the device accepts.
 */
function toFloat32(value: number): number {
  return Math.fround(value);
}

export default ConfigurationService;
