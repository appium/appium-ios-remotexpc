import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {type AccessibilityAuditService} from '../../src/index.js';
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
describe('AccessibilityAuditService', {timeout: 90000}, function () {
  let service: AccessibilityAuditService | null = null;

  before(async function () {
    const udid = requireDeviceUdid();
    service = await Services.startAccessibilityAuditService(udid);
  });

  after(function () {
    service?.close();
  });

  it('reports the daemon API version', async function () {
    const version = await service!.getApiVersion();

    assert.strictEqual(typeof version, 'number');
    // The daemon advertises 26 on iOS 27.0; any positive integer is acceptable.
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

    assert.ok(element, 'index 0 should resolve on iOS 27');
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
});
