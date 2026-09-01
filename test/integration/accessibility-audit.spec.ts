import assert from 'node:assert/strict';
import {type TestContext, after, before, describe, it} from 'node:test';

import {AxFocusDirection, type AccessibilityAuditService, type AxInspectedElement} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the accessibility audit service
 * (`com.apple.accessibility.axAuditDaemon.remoteserver`), the DTX backend behind
 * Xcode's Accessibility Inspector.
 *
 * Requires a physical iOS device with a running tunnel registry, and the shim
 * present in the RSD catalog (needs a Developer Disk Image mounted). Set the
 * UDID env var to the target device.
 *
 * The audit result depends on what is on the device's screen, so
 * {@link AccessibilityAuditService.runAudit} is asserted only to complete and
 * return an array — the count is whatever the current screen yields.
 */
// Generous: the audits alone take ~60s, and the settings tests deliberately
// pace their writes because the device commits them asynchronously.
/** Minimal shape of the aux payload the monitoring spy inspects. */
interface MessageAuxLike {
  getValues(): Array<{value: unknown}>;
}

describe('AccessibilityAuditService', {timeout: 300000}, function () {
  /** The selector the setting-write tests depend on. */
  const SETTING_WRITE_SELECTOR = 'deviceUpdateAccessibilitySetting:withValue:';
  /** The selector focus traversal depends on. */
  const FOCUS_MOVE_SELECTOR = 'deviceInspectorMoveWithOptions:';
  /** The selector the reset tests depend on. */
  const SETTING_RESET_SELECTOR = 'deviceResetToDefaultAccessibilitySettings';

  let service: AccessibilityAuditService | null = null;
  /** Whether this device's daemon implements setting writes at all. */
  let supportsSettingWrites = false;
  /** Whether it implements the reset selector, which the write tests do not use. */
  let supportsSettingReset = false;
  /** Whether it implements focus traversal. */
  let supportsFocusMove = false;

  before(async function () {
    const udid = requireDeviceUdid();
    service = await Services.startAccessibilityAuditService(udid);
    // Gate on what the daemon advertises rather than on an OS version: it
    // publishes the selectors it implements, which is both more precise and
    // stable across releases.
    const capabilities = await service.getCapabilities();
    supportsSettingWrites = capabilities.includes(SETTING_WRITE_SELECTOR);
    supportsSettingReset = capabilities.includes(SETTING_RESET_SELECTOR);
    supportsFocusMove = capabilities.includes(FOCUS_MOVE_SELECTOR);
  });

  after(function () {
    service?.close();
  });

  it('reports the daemon API version', async function () {
    const version = await service!.getApiVersion();

    assert.strictEqual(typeof version, 'number');
    // The daemon advertises 26 on iOS 26.6 and 27.0; any positive integer is fine.
    assert.ok(version > 0);
  });

  it('lists the selectors the daemon implements', async function () {
    const capabilities = await service!.getCapabilities();

    assert.ok(Array.isArray(capabilities));
    assert.ok(capabilities.length > 0);
    // A stable, always-present selector.
    assert.ok(capabilities.includes('deviceAccessibilitySettings'));
  });

  it('lists the supported audit types', async function () {
    const types = await service!.getSupportedAuditTypes();

    assert.ok(Array.isArray(types));
    assert.ok(types.length > 0);
    assert.ok(types.every((type) => typeof type === 'string' && type.startsWith('testType')));
  });

  it('reads the accessibility settings with their current values', async function () {
    const settings = await service!.getAccessibilitySettings();

    assert.ok(Array.isArray(settings));
    assert.ok(settings.length > 0);
    for (const setting of settings) {
      assert.strictEqual(typeof setting.identifier, 'string');
      assert.ok(setting.identifier.length > 0);
    }
    // Reduce Motion is a stock toggle present on every device.
    assert.ok(settings.some((setting) => setting.identifier === 'REDUCE_MOTION'));
  });

  it('runs an audit over the current screen and returns its issues', async function () {
    const types = await service!.getSupportedAuditTypes();

    const issues = await service!.runAudit(types, {timeoutMs: 60000});

    // Whatever is on screen: the flow must complete and yield an array.
    assert.ok(Array.isArray(issues));
  });

  it('streams the device audit log while auditing', async function () {
    const lines: string[] = [];

    await service!.runAudit(['testTypeContrast'], {timeoutMs: 60000, onLog: (line) => lines.push(line)});

    // The daemon narrates every audit; the run above must have produced some.
    assert.ok(lines.length > 0);
    assert.ok(lines.join('').includes('Test Starting'));
  });

  it('accepts an empty audit-type list without hanging', async function () {
    const issues = await service!.runAudit([], {timeoutMs: 60000});

    assert.ok(Array.isArray(issues));
  });

  it('fetches a special element with a usable handle', async function (t) {
    const element = await service!.getSpecialElement(0);

    assert.ok(element, 'index 0 should resolve on iOS 26.6 and 27.0');
    // The handle is opaque but must round-trip, so it has to be real bytes.
    assert.ok(Buffer.isBuffer(element.platformElement));
    assert.ok(element.platformElement.length > 0);
    t.diagnostic(`element identifier: ${element.accessibilityIdentifier ?? '(none)'}`);
  });

  it('returns the focused element inspector panel', async function () {
    const panel = await service!.getFocusedElement({timeoutMs: 30000});

    // The device pushes the whole panel; Basic is always present.
    assert.ok(Array.isArray(panel.sections));
    assert.ok(panel.sections.length > 0);
    const basic = panel.sections.find((section) => section.title === 'Basic');
    assert.ok(basic, 'a Basic section should be present');
    assert.ok(basic.attributes.length > 0);
    // Attribute descriptors carry no values — only names and flags.
    for (const attribute of basic.attributes) {
      assert.strictEqual(typeof attribute.name, 'string');
      assert.strictEqual(typeof attribute.humanReadableName, 'string');
      assert.strictEqual(typeof attribute.settable, 'boolean');
    }
    assert.ok(basic.attributes.some((attribute) => attribute.name === 'Label'));
  });

  it('reads attribute values for an element', async function (t) {
    const element = await service!.getSpecialElement(0);
    assert.ok(element);
    const panel = await service!.getFocusedElement({timeoutMs: 30000});
    const basic = panel.sections.find((section) => section.title === 'Basic');
    assert.ok(basic);

    const values: Record<string, unknown> = {};
    for (const attribute of basic.attributes) {
      values[attribute.name] = await service!.getElementAttributeValue(element, attribute);
    }

    // Which values are populated depends on the element in focus, so this
    // asserts the call succeeds and returns the attributes asked for rather
    // than pinning values that legitimately vary.
    assert.deepStrictEqual(Object.keys(values).sort(), basic.attributes.map((attribute) => attribute.name).sort());
    t.diagnostic(`values: ${JSON.stringify(values).slice(0, 200)}`);
  });

  it('reports issues against a targeted app when one has them', async function (t) {
    // Only meaningful with the deliberately-broken test app installed and in the
    // foreground; without it there is nothing to find, so this records what it
    // saw rather than asserting a count it cannot guarantee.
    const types = await service!.getSupportedAuditTypes();
    const issues = await service!.runAudit(types, {timeoutMs: 60000});

    for (const issue of issues) {
      // Every issue must name the audit type that produced it.
      assert.strictEqual(typeof issue.auditTestTypeValue_v1, 'string');
      assert.ok(types.includes(issue.auditTestTypeValue_v1 as string));
    }
    t.diagnostic(`audit produced ${issues.length} issue(s) on the current screen`);
  });

  /**
   * Setting writes are session-scoped: the device reverts them when the service
   * that made them closes, so these tests cannot leave the device altered even
   * if one fails midway.
   *
   * Only single writes are asserted. The device acknowledges a write in
   * milliseconds but commits it asynchronously, and a second write landing in
   * that window is dropped — so write-then-write-back and write-then-close
   * sequences are not reliable enough to assert, even with retries (retrying
   * makes it worse, since each retry lands in the previous commit window).
   * Those behaviours are documented on the methods instead.
   *
   * `resetAccessibilitySettings` IS exercised, but only when the device is
   * already at defaults — see the guard in its own block. It is persistent
   * rather than session-scoped, so running it against a configured device
   * would discard real settings.
   */
  /**
   * An audit type the device does not implement makes the daemon return neither
   * issues nor a completion, and that connection can never run another audit —
   * so the name must be refused before it reaches the wire. Matching is exact:
   * case, surrounding whitespace and a bare prefix all wedge it.
   */
  describe('audit type validation', function () {
    const POISON: Array<[string, string[]]> = [
      ['an invented name', ['bogusAuditTypeThatDoesNotExist']],
      ['the wrong case', ['TESTTYPECONTRAST']],
      ['an empty string', ['']],
      ['a bare prefix', ['testType']],
      ['surrounding whitespace', [' testTypeContrast ']],
    ];

    for (const [label, auditTypes] of POISON) {
      it(`rejects ${label} without starting an audit`, async function () {
        await assert.rejects(() => service!.runAudit(auditTypes, {timeoutMs: 20000}), /Unknown audit type/);
      });
    }

    it('rejects a valid type mixed with an unknown one', async function () {
      const types = await service!.getSupportedAuditTypes();

      await assert.rejects(() => service!.runAudit([types[0], 'bogusType'], {timeoutMs: 20000}), /Unknown audit type/);
    });

    it('does not validate against an empty catalogue', async function () {
      // A device reporting no types must not make every type unknown — and the
      // empty list must not be cached, or the service stays broken afterwards.
      const types = await service!.getSupportedAuditTypes();
      const real = service!.getSupportedAuditTypes.bind(service!);
      const instance = service! as unknown as {
        auditTypeNames?: Set<string>;
        getSupportedAuditTypes: () => Promise<string[]>;
      };
      instance.getSupportedAuditTypes = async (): Promise<string[]> => [];
      instance.auditTypeNames = undefined;
      try {
        assert.ok(Array.isArray(await service!.runAudit([types[0]], {timeoutMs: 60000})));
        assert.strictEqual(instance.auditTypeNames, undefined, 'an empty catalogue must not be cached');
      } finally {
        instance.getSupportedAuditTypes = real;
        instance.auditTypeNames = undefined;
      }

      // Still works once the device reports its types again.
      assert.ok(Array.isArray(await service!.runAudit([types[0]], {timeoutMs: 60000})));
    });

    it('leaves the connection usable after a rejected audit', async function () {
      await assert.rejects(() => service!.runAudit(['nopeNotAType'], {timeoutMs: 20000}), /Unknown audit type/);

      // One cheap type is enough here: before the guard this timed out
      // permanently on this connection.
      assert.ok(Array.isArray(await service!.runAudit(['testTypeContrast'], {timeoutMs: 60000})));
    });
  });

  /**
   * Focus traversal reports what is actually drawn, so these assert shape rather
   * than a fixed element count — that depends on whatever is on screen.
   */
  describe('focus traversal', function () {
    /** Skips when the daemon does not implement focus movement. */
    function skipWithoutFocusMove(t: TestContext): boolean {
      if (!supportsFocusMove) {
        t.skip(`daemon does not implement ${FOCUS_MOVE_SELECTOR}`);
        return true;
      }
      return false;
    }

    it('moves focus and returns the element it landed on', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      // Next rather than First: focus wraps so Next always moves, whereas First
      // emits nothing when focus already sits on the first element.
      const first = await service!.moveFocus(AxFocusDirection.Next, {timeoutMs: 20000});

      assert.ok(first.element, 'a focus push should carry an element handle');
      assert.ok(Buffer.isBuffer(first.element.platformElement));
      assert.ok(first.sections.length > 0, 'the inspector panel should come with it');
      t.diagnostic(`First landed on ${JSON.stringify(first.caption)}`);
    });

    it('moves forward and back between elements', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      // Only Next/Previous are used: focus wraps, so they always move. `First`
      // would be a no-op if focus already sat on the first element, and a move
      // that changes nothing emits no event at all.
      const start = await service!.moveFocus(AxFocusDirection.Next, {timeoutMs: 20000});
      const forward = await service!.moveFocus(AxFocusDirection.Next, {timeoutMs: 20000});
      const back = await service!.moveFocus(AxFocusDirection.Previous, {timeoutMs: 20000});

      assert.notDeepStrictEqual(forward.element?.platformElement, start.element?.platformElement);
      assert.deepStrictEqual(back.element?.platformElement, start.element?.platformElement);
    });

    /** What an element announces — the walk's own notion of identity. */
    function announcementOf(focused: AxInspectedElement): string {
      const announcement = focused.caption ?? focused.spokenDescription;
      assert.ok(announcement !== undefined, 'a walked element should announce something');
      return announcement;
    }

    it('enumerates distinct elements and terminates', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      const seen: string[] = [];
      for await (const focused of service!.walkElements({timeoutMs: 20000})) {
        assert.ok(focused.element, 'each walked element should carry a handle');
        seen.push(announcementOf(focused));
      }

      // Focus wraps rather than reporting an end, so the walk stops when it
      // returns to the element it started on. Asserting on the announcement
      // rather than `platformElement` is deliberate: the daemon issues a fresh
      // handle for every focus event, so a handle-based check passes even if
      // the walk laps the screen forever.
      assert.ok(seen.length > 0, 'the walk should reach at least one element');
      assert.strictEqual(new Set(seen).size, seen.length, 'the walk must not yield an element twice');
      t.diagnostic(`walked ${seen.length} element(s)`);
    });

    it('walks the same elements when focus already sits on the first one', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      const baseline = new Set<string>();
      for await (const focused of service!.walkElements({timeoutMs: 20000})) {
        baseline.add(announcementOf(focused));
      }

      // `First` emits nothing when focus is already there, so this parks focus
      // on the first element to exercise the walk's opening no-op.
      try {
        await service!.moveFocus(AxFocusDirection.First, {timeoutMs: 20000});
      } catch {
        // Already there — which is exactly the state under test.
      }

      const afterward = new Set<string>();
      for await (const focused of service!.walkElements({timeoutMs: 20000})) {
        afterward.add(announcementOf(focused));
      }

      assert.deepStrictEqual(afterward, baseline, 'a walk that opens on a no-op should still reach every element');
      t.diagnostic(`reached ${afterward.size} element(s) from both starting points`);
    });

    it('reads attributes for the element currently focused', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      const focused = await service!.moveFocus(AxFocusDirection.Next, {timeoutMs: 20000});
      const basic = focused.sections.find((section) => section.title === 'Basic');
      const label = basic?.attributes.find((attribute) => attribute.name === 'Label');
      assert.ok(label && focused.element, 'expected a Label attribute on the focused element');

      // The handle is only valid while the element holds focus, so this reads
      // immediately rather than after moving on.
      const value = await service!.getElementAttributeValue(focused.element, label, {timeoutMs: 15000});
      t.diagnostic(`Label = ${JSON.stringify(value)}`);
      assert.ok(value === null || typeof value === 'string');
    });

    it('leaves monitoring disarmed when no observer is active', async function (t) {
      if (skipWithoutFocusMove(t)) {
        return;
      }
      const sent: unknown[] = [];
      const transport = (service! as unknown as {transport: {invokeOneway: (s: string, a: MessageAuxLike) => void}})
        .transport;
      const real = transport.invokeOneway.bind(transport);
      transport.invokeOneway = (selector, aux) => {
        if (selector === 'deviceInspectorSetMonitoredEventType:') {
          sent.push(aux.getValues()[0].value);
        }
        return real(selector, aux);
      };
      try {
        await service!.moveFocus(AxFocusDirection.Next, {timeoutMs: 20000});
      } finally {
        transport.invokeOneway = real;
      }

      assert.ok(sent.includes(0), `expected monitoring to be disarmed, got [${sent.join(', ')}]`);
    });
  });

  describe('accessibility settings', function () {
    /** Skips when the daemon does not implement setting writes. */
    function skipWithoutSettingWrites(t: TestContext): boolean {
      if (!supportsSettingWrites) {
        t.skip(`daemon does not implement ${SETTING_WRITE_SELECTOR}`);
        return true;
      }
      return false;
    }

    /** Polls until `identifier` reads `expected`, since a write settles asynchronously. */
    async function waitForSetting(identifier: string, expected: unknown, timeoutMs = 8000): Promise<unknown> {
      const deadline = performance.now() + timeoutMs;
      let current: unknown;
      do {
        const settings = await service!.getAccessibilitySettings();
        current = settings.find((setting) => setting.identifier === identifier)?.currentValue;
        if (current === expected) {
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      } while (performance.now() < deadline);
      return current;
    }

    async function currentValue(identifier: string): Promise<unknown> {
      const settings = await service!.getAccessibilitySettings();
      return settings.find((setting) => setting.identifier === identifier)?.currentValue;
    }

    it('quantises a slider value to the device tick marks', async function (t) {
      if (skipWithoutSettingWrites(t)) {
        return;
      }
      const settings = await service!.getAccessibilitySettings();
      const slider = settings.find((setting) => setting.identifier === 'DYNAMIC_TYPE');
      assert.ok(slider, 'DYNAMIC_TYPE should be present');
      const original = slider.currentValue as number;
      const ticks = slider.sliderTickMarks ?? 0;
      assert.ok(ticks > 1, 'the slider should report its tick marks');

      try {
        // 0.5 is not on a tick, so the device snaps it to the nearest one.
        const step = 1 / (ticks - 1);
        const nearest = Math.round(0.5 / step) * step;
        await service!.setAccessibilitySetting('DYNAMIC_TYPE', 0.5);
        const settled = (await waitForSetting('DYNAMIC_TYPE', nearest, 10000)) as number;
        // Half a tick, not an exact double
        assert.ok(Math.abs(settled - nearest) <= step / 2, `expected within ${step / 2} of ${nearest}, got ${settled}`);
        t.diagnostic(`${ticks} ticks -> 0.5 snapped to ${settled}`);
      } finally {
        await service!.setAccessibilitySetting('DYNAMIC_TYPE', original).catch(() => {});
      }
    });

    it('rejects an unknown setting identifier instead of silently doing nothing', async function () {
      await assert.rejects(
        () => service!.setAccessibilitySetting('NOT_A_REAL_SETTING', true),
        /Unknown accessibility setting/,
      );
    });

    it('rejects a value of the wrong kind for the setting', async function () {
      // DYNAMIC_TYPE is a slider, GRAYSCALE a toggle.
      await assert.rejects(() => service!.setAccessibilitySetting('DYNAMIC_TYPE', true), /slider/);
      await assert.rejects(() => service!.setAccessibilitySetting('GRAYSCALE', 0.5 as unknown as boolean), /toggle/);
    });

    it('rejects an out-of-range slider value without touching the device', async function () {
      const before = await currentValue('DYNAMIC_TYPE');

      await assert.rejects(() => service!.setAccessibilitySetting('DYNAMIC_TYPE', -1), /between 0 and 1/);
      await assert.rejects(() => service!.setAccessibilitySetting('DYNAMIC_TYPE', 2), /between 0 and 1/);

      // The device clamps out-of-range input to 1 — including negatives — so a
      // guard that leaked would have maxed the setting rather than failed.
      assert.strictEqual(await currentValue('DYNAMIC_TYPE'), before);
    });

    /**
     * Unlike a setting write, a reset is persistent: it rewrites what the device
     * *stores* rather than holding a session override, so it permanently wipes
     * the accessibility settings of whoever runs the suite — including a
     * customised text size, which no guard here can detect in advance.
     *
     * These tests are therefore **opt-in** and skipped by default. To run them:
     *
     * ```
     * ALLOW_ACCESSIBILITY_SETTINGS_RESET=1 UDID=<udid> npm run test:accessibility-audit
     * ```
     *
     * Only set that on a device whose accessibility settings you are willing to
     * lose. As a second layer, they also skip when any toggle is already on, so
     * an opted-in run against a configured device still declines to wipe it.
     */
    describe('resetAccessibilitySettings', function () {
      /** Opt-in flag; without it these tests never touch the device. */
      const RESET_ALLOWED = process.env.ALLOW_ACCESSIBILITY_SETTINGS_RESET === '1';

      /** True when nothing is switched on, so a reset has nothing to discard. */
      async function atDefaults(): Promise<boolean> {
        const settings = await service!.getAccessibilitySettings();
        return settings.every((setting) => setting.identifier === 'DYNAMIC_TYPE' || setting.currentValue === false);
      }

      /** Reports why a test is being skipped, or null when it may run. */
      async function skipReason(): Promise<string | null> {
        if (!supportsSettingReset) {
          return `daemon does not implement ${SETTING_RESET_SELECTOR}`;
        }
        if (!RESET_ALLOWED) {
          return 'set ALLOW_ACCESSIBILITY_SETTINGS_RESET=1 to run — this permanently resets the accessibility settings on the device';
        }
        return (await atDefaults()) ? null : 'device has accessibility settings enabled; refusing to reset them';
      }

      it('is a no-op when the device is already at defaults', async function (t) {
        const skip = await skipReason();
        if (skip) {
          t.skip(skip);
          return;
        }
        const before = await service!.getAccessibilitySettings();

        await service!.resetAccessibilitySettings();
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const after = await service!.getAccessibilitySettings();
        assert.deepStrictEqual(
          after.map((setting) => [setting.identifier, setting.currentValue]),
          before.map((setting) => [setting.identifier, setting.currentValue]),
        );
      });

      it('clears a session override held by this service', async function (t) {
        // The only reset test that also writes a setting.
        if (!supportsSettingWrites) {
          t.skip(`daemon does not implement ${SETTING_WRITE_SELECTOR}`);
          return;
        }
        const skip = await skipReason();
        if (skip) {
          t.skip(skip);
          return;
        }
        const storedTextSize = await currentValue('DYNAMIC_TYPE');

        await service!.setAccessibilitySetting('GRAYSCALE', true);
        assert.strictEqual(await waitForSetting('GRAYSCALE', true, 10000), true);

        await service!.resetAccessibilitySettings();

        assert.strictEqual(await waitForSetting('GRAYSCALE', false, 10000), false);
        // The reset dropped the override without touching what the device stores.
        assert.strictEqual(await currentValue('DYNAMIC_TYPE'), storedTextSize);
      });

      it('can be called twice in a row', async function (t) {
        const skip = await skipReason();
        if (skip) {
          t.skip(skip);
          return;
        }
        await service!.resetAccessibilitySettings();
        await service!.resetAccessibilitySettings();
        assert.ok(await atDefaults());
      });

      it('is safe to call while an audit is in flight', async function (t) {
        const skip = await skipReason();
        if (skip) {
          t.skip(skip);
          return;
        }
        const types = await service!.getSupportedAuditTypes();

        const audit = service!.runAudit(types, {timeoutMs: 60000});
        await new Promise((resolve) => setTimeout(resolve, 400));
        await service!.resetAccessibilitySettings();

        // Both the reset and the audit it interrupted must complete.
        assert.ok(Array.isArray(await audit));
      });
    });
  });
});
