import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {serializeAxSetting} from '../../../src/services/ios/accessibility-audit/index.js';

/**
 * The descriptor sent with `deviceUpdateAccessibilitySetting:withValue:`.
 *
 * The device reads only the identifier — sending a deliberately wrong
 * `SettingTypeValue_v1` or `SliderTickMarksValue_v1` still applies the setting —
 * so this deliberately does not echo a full descriptor back.
 */
describe('serializeAxSetting', function () {
  it('wraps the identifier in the AXAuditDeviceSetting_v1 envelope', function () {
    assert.deepStrictEqual(serializeAxSetting('INVERT_COLORS'), {
      ObjectType: 'AXAuditDeviceSetting_v1',
      Value: {
        ObjectType: 'passthrough',
        Value: {IdentiifierValue_v1: {ObjectType: 'passthrough', Value: 'INVERT_COLORS'}},
      },
    });
  });

  it('carries the identifier verbatim, including the daemon typo key', function () {
    const wire = serializeAxSetting('DYNAMIC_TYPE') as {Value: {Value: Record<string, {Value: string}>}};

    // `IdentiifierValue_v1` is the daemon's own misspelling; matching it exactly
    // is load-bearing, not a typo on our side.
    assert.deepStrictEqual(Object.keys(wire.Value.Value), ['IdentiifierValue_v1']);
    assert.strictEqual(wire.Value.Value.IdentiifierValue_v1.Value, 'DYNAMIC_TYPE');
  });

  it('sends no type, tick-mark or enabled fields', function () {
    const wire = serializeAxSetting('GRAYSCALE') as {Value: {Value: Record<string, unknown>}};
    const fields = Object.keys(wire.Value.Value);

    for (const ignored of [
      'SettingTypeValue_v1',
      'SliderTickMarksValue_v1',
      'EnabledValue_v1',
      'CurrentValueNumber_v1',
    ]) {
      assert.ok(!fields.includes(ignored), `${ignored} should not be sent`);
    }
  });
});
