import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';

import {PlistUID} from '../../src/lib/plist/plist-uid.js';
import {NSKeyedArchiverEncoder} from '../../src/services/ios/dvt/nskeyedarchiver-encoder.js';

describe('NSKeyedArchiver Encoder', function () {
  let encoder: NSKeyedArchiverEncoder;

  beforeEach(function () {
    encoder = new NSKeyedArchiverEncoder();
  });

  describe('encode', function () {
    it('should produce a valid NSKeyedArchiver envelope', function () {
      const result = encoder.encode('hello');

      assert.strictEqual(result.$version, 100000);
      assert.strictEqual(result.$archiver, 'NSKeyedArchiver');
      assert.ok(result.$top.root instanceof PlistUID);
      assert.strictEqual(result.$objects[0], '$null');
    });

    it('should encode null/undefined as $null reference (index 0)', function () {
      assert.strictEqual(encoder.encode(null).$top.root.value, 0);
      assert.strictEqual(new NSKeyedArchiverEncoder().encode(undefined).$top.root.value, 0);
    });

    it('should encode a string value', function () {
      const result = encoder.encode('test string');

      assert.strictEqual(result.$objects[result.$top.root.value], 'test string');
    });

    it('should encode a numeric value', function () {
      const result = encoder.encode(42);

      assert.strictEqual(result.$objects[result.$top.root.value], 42);
    });

    it('should encode a boolean value', function () {
      const result = encoder.encode(true);

      assert.strictEqual(result.$objects[result.$top.root.value], true);
    });

    it('should encode an array as NSArray with element UIDs', function () {
      const result = encoder.encode(['a', 'b', 'c']);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const items = arrayObj['NS.objects'].map((uid: PlistUID) => result.$objects[uid.value]);
      assert.deepStrictEqual(items, ['a', 'b', 'c']);

      const classDef = result.$objects[arrayObj.$class.value];
      assert.strictEqual(classDef.$classname, 'NSArray');
      assert.deepStrictEqual(classDef.$classes, ['NSArray', 'NSObject']);
    });

    it('should map null elements in an array to the $null sentinel', function () {
      const result = encoder.encode([1, null, 'x']);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const items = arrayObj['NS.objects'].map((uid: PlistUID) => result.$objects[uid.value]);
      assert.deepStrictEqual(items, [1, '$null', 'x']);
    });

    it('should encode a plain object as NSDictionary with key and value UIDs', function () {
      const result = encoder.encode({key1: 'value1', key2: 'value2'});
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const keys = dictObj['NS.keys'].map((uid: PlistUID) => result.$objects[uid.value]);
      const values = dictObj['NS.objects'].map((uid: PlistUID) => result.$objects[uid.value]);

      assert.deepStrictEqual(keys, ['key1', 'key2']);
      assert.deepStrictEqual(values, ['value1', 'value2']);

      const classDef = result.$objects[dictObj.$class.value];
      assert.strictEqual(classDef.$classname, 'NSDictionary');
      assert.deepStrictEqual(classDef.$classes, ['NSDictionary', 'NSObject']);
    });

    it('should encode a Buffer as NSMutableData', function () {
      const buf = Buffer.from([0x01, 0x02, 0x03]);
      const result = encoder.encode(buf);
      const rootIdx = result.$top.root.value;
      const dataObj = result.$objects[rootIdx];

      assert.deepStrictEqual(dataObj['NS.data'], buf);

      const classDef = result.$objects[dataObj.$class.value];
      assert.strictEqual(classDef.$classname, 'NSMutableData');
      assert.deepStrictEqual(classDef.$classes, ['NSMutableData', 'NSData', 'NSObject']);
    });

    it('should encode nested dictionaries inside an array', function () {
      const result = encoder.encode([{id: 'a'}, {id: 'b'}]);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      for (const uid of arrayObj['NS.objects']) {
        const dictObj = result.$objects[uid.value];
        assert.ok('NS.keys' in dictObj);
        assert.ok('NS.objects' in dictObj);
      }
    });

    it('should encode a nested array inside a dictionary', function () {
      const result = encoder.encode({items: ['x', 'y']});
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const nestedArray = result.$objects[dictObj['NS.objects'][0].value];
      const items = nestedArray['NS.objects'].map((uid: PlistUID) => result.$objects[uid.value]);
      assert.deepStrictEqual(items, ['x', 'y']);
    });

    it('should deduplicate identical object references via the cache', function () {
      const shared = {reused: true};
      const result = encoder.encode([shared, shared]);

      const rootIdx = result.$top.root.value;
      const [uid1, uid2] = result.$objects[rootIdx]['NS.objects'];

      assert.strictEqual(uid1.value, uid2.value);
    });

    it('should handle circular references without infinite recursion', function () {
      const obj: any = {name: 'root'};
      obj.self = obj;

      const result = encoder.encode(obj);
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const keys = dictObj['NS.keys'].map((uid: PlistUID) => result.$objects[uid.value]);
      const valUids = dictObj['NS.objects'];

      assert.deepStrictEqual(keys, ['name', 'self']);
      // The 'self' value UID should point back to the root dictionary itself
      assert.strictEqual(valUids[1].value, rootIdx);
    });

    it('should reuse class definitions across objects of the same type', function () {
      const result = encoder.encode([{a: 1}, {b: 2}]);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const dict1 = result.$objects[arrayObj['NS.objects'][0].value];
      const dict2 = result.$objects[arrayObj['NS.objects'][1].value];

      assert.strictEqual(dict1.$class.value, dict2.$class.value);
    });

    it('should encode unsupported types as $null', function () {
      const result = encoder.encode(Symbol('test'));

      assert.strictEqual(result.$top.root.value, 0);
    });
  });
});
