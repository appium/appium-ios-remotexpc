import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AX_OBJECT_TYPE, deserializeAxObject} from '../../../src/services/ios/accessibility-audit/ax-deserialize.js';

describe('deserializeAxObject', function () {
  it('returns primitives unchanged', function () {
    assert.strictEqual(deserializeAxObject(26), 26);
    assert.strictEqual(deserializeAxObject('INVERT_COLORS'), 'INVERT_COLORS');
    assert.strictEqual(deserializeAxObject(true), true);
    assert.strictEqual(deserializeAxObject(null), null);
  });

  it('unwraps a passthrough envelope to its inner value', function () {
    assert.strictEqual(deserializeAxObject({ObjectType: 'passthrough', Value: 'REDUCE_MOTION'}), 'REDUCE_MOTION');
    assert.strictEqual(deserializeAxObject({ObjectType: 'passthrough', Value: 3}), 3);
  });

  it('unwraps nested passthrough envelopes', function () {
    const nested = {
      ObjectType: 'passthrough',
      Value: {ObjectType: 'passthrough', Value: false},
    };
    assert.strictEqual(deserializeAxObject(nested), false);
  });

  it('tags a typed object and flattens its fields', function () {
    // The real shape of one accessibility setting from the device.
    const setting = {
      ObjectType: 'AXAuditDeviceSetting_v1',
      Value: {
        ObjectType: 'passthrough',
        Value: {
          IdentiifierValue_v1: {ObjectType: 'passthrough', Value: 'INVERT_COLORS'},
          SettingTypeValue_v1: {ObjectType: 'passthrough', Value: 3},
          CurrentValueNumber_v1: {ObjectType: 'passthrough', Value: false},
          EnabledValue_v1: {ObjectType: 'passthrough', Value: true},
        },
      },
    };

    assert.deepStrictEqual(deserializeAxObject(setting), {
      IdentiifierValue_v1: 'INVERT_COLORS',
      SettingTypeValue_v1: 3,
      CurrentValueNumber_v1: false,
      EnabledValue_v1: true,
      [AX_OBJECT_TYPE]: 'AXAuditDeviceSetting_v1',
    });
  });

  it('deserializes each element of an array', function () {
    const list = [
      {ObjectType: 'passthrough', Value: 'a'},
      {ObjectType: 'passthrough', Value: 'b'},
    ];
    assert.deepStrictEqual(deserializeAxObject(list), ['a', 'b']);
  });

  it('recurses into a plain dictionary that has no ObjectType', function () {
    const plain = {
      count: 2,
      first: {ObjectType: 'passthrough', Value: 'x'},
    };
    assert.deepStrictEqual(deserializeAxObject(plain), {count: 2, first: 'x'});
  });

  it('wraps a typed object whose value is not a dictionary under `value`', function () {
    const typed = {ObjectType: 'AXAuditElement_v1', Value: {ObjectType: 'passthrough', Value: 'raw'}};
    assert.deepStrictEqual(deserializeAxObject(typed), {value: 'raw', [AX_OBJECT_TYPE]: 'AXAuditElement_v1'});
  });

  it('handles the empty settings list', function () {
    assert.deepStrictEqual(deserializeAxObject([]), []);
  });
});
