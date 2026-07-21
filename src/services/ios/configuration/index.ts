import {asDictionary} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary} from '../../../lib/types.js';
import {type CoreDeviceInvokeOptions, CoreDeviceError, CoreDeviceService} from '../core-device/core-device-service.js';

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
  GET_INCREASE_CONTRAST: 'com.apple.coredevice.action.getdeviceincreasecontrast',
  SET_INCREASE_CONTRAST: 'com.apple.coredevice.action.setdeviceincreasecontrast',
  GET_SHOW_BORDERS: 'com.apple.coredevice.action.getshowborders',
  SET_SHOW_BORDERS: 'com.apple.coredevice.action.setshowborders',
  GET_REDUCE_TRANSPARENCY: 'com.apple.coredevice.action.getreducetransparency',
  SET_REDUCE_TRANSPARENCY: 'com.apple.coredevice.action.setreducetransparency',
} as const;

/**
 * Device appearance. Today the daemon only reports/accepts `'dark'` and
 * `'light'`, so those are surfaced as literals for autocomplete — but the type
 * stays open (`string & {}`) so a future OS that adds another style is neither
 * rejected on read nor unrepresentable on write.
 */
export type UserInterfaceStyle = 'dark' | 'light' | (string & {});

/**
 * Dynamic Type content-size names accepted by the daemon's `setdevicetextsize`
 * action. These are the seven standard sizes.
 */
const DEVICE_TEXT_SIZES = [
  'extraSmall',
  'small',
  'medium',
  'large',
  'extraLarge',
  'extraExtraLarge',
  'extraExtraExtraLarge',
] as const;

/** A valid Dynamic Type content-size name. See {@link DEVICE_TEXT_SIZES}. */
export type DeviceTextSize = (typeof DEVICE_TEXT_SIZES)[number];

/**
 * Color-filter presets that enable from `filterType` alone.
 */
const COLOR_FILTER_TYPES = ['Grayscale', 'Protanopia', 'Deuteranopia', 'Tritanopia'] as const;

/** A color-filter preset that enables from a name alone. See {@link COLOR_FILTER_TYPES}. */
export type ColorFilterType = (typeof COLOR_FILTER_TYPES)[number];

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
  /** Filter preset (e.g. `'Protanopia'`). Required when enabling. */
  filterType?: ColorFilterType;
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

  /**
   * Returns the active appearance. Normally `'dark'` or `'light'`, but any
   * string the device reports is passed through unchanged (so a future OS style
   * is not rejected). Only a missing/non-string value — a malformed reply —
   * throws a {@link CoreDeviceError}.
   */
  async getUserInterfaceStyle(options: CoreDeviceInvokeOptions = {}): Promise<UserInterfaceStyle> {
    const output = await this.action(ACTION.GET_USER_INTERFACE_STYLE, {}, options);
    const style = output.style;
    if (typeof style !== 'string') {
      throw new CoreDeviceError(`Missing user-interface style in device response: ${String(style)}`, output);
    }
    return style;
  }

  /**
   * Sets the device appearance. `'dark'` and `'light'` are the known values; any
   * other non-empty string is forwarded to the device (which validates it), so a
   * future OS style is not blocked client-side. An empty/non-string value throws
   * a `TypeError`.
   */
  async setUserInterfaceStyle(style: UserInterfaceStyle, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    if (typeof style !== 'string' || style.length === 0) {
      throw new TypeError(`style must be a non-empty string, got '${String(style)}'`);
    }
    await this.action(ACTION.SET_USER_INTERFACE_STYLE, {style}, options);
  }

  /**
   * Sets the system liquid-glass opacity (iOS 26). `opacity` is range-checked to
   * `[0.0, 1.0]` and quantized to IEEE-754 binary32.
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
    // Quantize to IEEE-754 binary32: the daemon's Swift decoders reject floats
    // whose low mantissa bits don't fit in Float32.
    await this.action(ACTION.SET_LIQUID_GLASS, {configuration: {opacity: Math.fround(opacity)}}, options);
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
   * Sets the color filter. `filterType` is required when `enabled` is true and
   * must be one of {@link ColorFilterType} (`'Grayscale'`, `'Protanopia'`,
   * `'Deuteranopia'`, `'Tritanopia'`) — the presets verified to enable from a
   * name. Names are case-sensitive; an unknown value throws a `TypeError`.
   *
   * ⚠️ `intensity` is device-gated: on the tested device any `intensity` value is
   * rejected with `com.apple.dt.CoreDeviceError 21056` ("The color filter
   * intensity value is not valid."), surfaced here as a {@link CoreDeviceError}.
   * Omit it unless you know the target device accepts it.
   */
  async setColorFilter(enabled: boolean, options: SetColorFilterOptions & CoreDeviceInvokeOptions = {}): Promise<void> {
    const {filterType, intensity, ...invokeOptions} = options;
    const colorFilter: XPCDictionary = {enabled};
    // filterType/intensity only apply when enabling. When disabling we send just
    // `{ enabled: false }` and intentionally drop them.
    if (enabled) {
      if (filterType === undefined) {
        throw new TypeError('filterType is required when enabling the color filter');
      }
      if (!isOneOf(COLOR_FILTER_TYPES, filterType)) {
        throw new TypeError(`filterType must be one of ${COLOR_FILTER_TYPES.join(', ')}, got '${String(filterType)}'`);
      }
      colorFilter.filterType = {name: filterType};
      if (intensity !== undefined) {
        colorFilter.intensity = Math.fround(intensity);
      }
    }
    await this.action(ACTION.SET_COLOR_FILTER, {colorFilter}, invokeOptions);
  }

  /** Returns the Dynamic Type size name (e.g. `'medium'`, `'large'`). */
  async getDeviceTextSize(options: CoreDeviceInvokeOptions = {}): Promise<DeviceTextSize | undefined> {
    const output = await this.action(ACTION.GET_DEVICE_TEXT_SIZE, {}, options);
    const size = asDictionary(asDictionary(output.textSize)?.size);
    return size ? (Object.keys(size)[0] as DeviceTextSize) : undefined;
  }

  /** Sets the Dynamic Type size by name (`'medium'`, `'large'`, …). */
  async setDeviceTextSize(size: DeviceTextSize, options: CoreDeviceInvokeOptions = {}): Promise<void> {
    if (!isOneOf(DEVICE_TEXT_SIZES, size)) {
      throw new TypeError(`size must be one of ${DEVICE_TEXT_SIZES.join(', ')}, got '${String(size)}'`);
    }
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

  /** Returns whether Increase Contrast is enabled. */
  async getIncreaseContrast(options: CoreDeviceInvokeOptions = {}): Promise<boolean> {
    return this.getEnabled(ACTION.GET_INCREASE_CONTRAST, 'increaseContrast', options);
  }

  /** Toggles Increase Contrast. */
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
 * Type guard for membership in an `as const` list of string literals. Lets a
 * single declaration be the source of truth for both a union type
 * (`(typeof list)[number]`) and its runtime validation.
 */
function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export default ConfigurationService;
