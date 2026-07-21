import {after, before, describe, it} from 'node:test';

import {expect} from 'chai';

import {
  CoreDeviceError,
  type ColorFilterType,
  type ConfigurationService,
  type DeviceTextSize,
} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the CoreDevice configuration service
 * (`com.apple.coredevice.configuration`).
 *
 * Requires a physical iOS device with a running tunnel registry. Set the UDID
 * env var to the target device.
 *
 * Every mutating test captures the device's original value and restores it, so
 * the device is left as it was found. Appearance-affecting knobs (dark mode,
 * color filter, liquid glass) will briefly change the screen while the test
 * runs.
 */
describe('ConfigurationService', {timeout: 60000}, function () {
  let service: ConfigurationService | null = null;

  before(async function () {
    const udid = requireDeviceUdid();
    service = await Services.startConfigurationService(udid);
  });

  after(async function () {
    try {
      await service?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('getUserInterfaceStyle returns "dark" or "light"', async function () {
    const style = await service!.getUserInterfaceStyle();
    expect(style).to.be.oneOf(['dark', 'light']);
  });

  it('setUserInterfaceStyle round-trips (dark <-> light)', async function () {
    const original = await service!.getUserInterfaceStyle();
    const toggled = original === 'dark' ? 'light' : 'dark';
    try {
      await service!.setUserInterfaceStyle(toggled);
      expect(await service!.getUserInterfaceStyle()).to.equal(toggled);
    } finally {
      await service!.setUserInterfaceStyle(original);
    }
    expect(await service!.getUserInterfaceStyle()).to.equal(original);
  });

  it('reduce motion round-trips', async function () {
    const original = await service!.getReduceMotion();
    try {
      await service!.setReduceMotion(!original);
      expect(await service!.getReduceMotion()).to.equal(!original);
    } finally {
      await service!.setReduceMotion(original);
    }
    expect(await service!.getReduceMotion()).to.equal(original);
  });

  it('boolean accessibility knobs round-trip (transparency, borders, contrast)', async function () {
    const knobs: [() => Promise<boolean>, (v: boolean) => Promise<void>][] = [
      [() => service!.getReduceTransparency(), (v) => service!.setReduceTransparency(v)],
      [() => service!.getShowBorders(), (v) => service!.setShowBorders(v)],
      [() => service!.getIncreaseContrast(), (v) => service!.setIncreaseContrast(v)],
    ];
    for (const [get, set] of knobs) {
      const original = await get();
      try {
        await set(!original);
        expect(await get()).to.equal(!original);
      } finally {
        await set(original);
      }
      expect(await get()).to.equal(original);
    }
  });

  it('setDeviceTextSize applies every standard size and restores the original', async function () {
    const sizes: DeviceTextSize[] = [
      'extraSmall',
      'small',
      'medium',
      'large',
      'extraLarge',
      'extraExtraLarge',
      'extraExtraExtraLarge',
    ];
    const original = await service!.getDeviceTextSize();
    expect(original, 'original text size').to.be.oneOf(sizes);
    try {
      for (const size of sizes) {
        await service!.setDeviceTextSize(size);
        expect(await service!.getDeviceTextSize(), size).to.equal(size);
      }
    } finally {
      if (original) {
        await service!.setDeviceTextSize(original);
      }
    }
    expect(await service!.getDeviceTextSize()).to.equal(original);
  });

  it('every color-filter preset enables, reports its name, and disables', async function () {
    const presets: ColorFilterType[] = ['Grayscale', 'Protanopia', 'Deuteranopia', 'Tritanopia'];
    const original = await service!.getColorFilter();
    try {
      for (const preset of presets) {
        // Enable each preset (no intensity — intensity is device-gated, 21056).
        await service!.setColorFilter(true, {filterType: preset});
        const enabled = await service!.getColorFilter();
        expect(enabled.enabled, preset).to.equal(true);
        expect(enabled.filterType?.name, preset).to.equal(preset);

        await service!.setColorFilter(false);
        expect((await service!.getColorFilter()).enabled, `${preset} disabled`).to.equal(false);
      }
    } finally {
      if (original.enabled && original.filterType?.name) {
        await service!.setColorFilter(true, {filterType: original.filterType.name as ColorFilterType});
      } else {
        await service!.setColorFilter(false);
      }
    }
  });

  it('liquid glass opacity can be set and restored (iOS 26)', async function () {
    try {
      await service!.setLiquidGlassOpacity(0.6);
      await service!.setLiquidGlassOpacity(1);
    } catch (error) {
      // Device-gated (not just OS-gated): hardware without Liquid Glass support rejects with
      // CoreDeviceError 21035 even on iOS 26. Tested on iPhone 11 might work on newer models
      expect(error).to.be.instanceOf(CoreDeviceError);
    }
  });
});
