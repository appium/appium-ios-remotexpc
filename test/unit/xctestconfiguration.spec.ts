import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';

import {PlistUID} from '../../src/lib/plist/index.js';
import {
  XCTestConfigurationEncoder,
  createNSURL,
  createNSUUID,
} from '../../src/services/ios/testmanagerd/xctestconfiguration.js';

function getRootConfig(result: any): {objects: any[]; configObj: any} {
  const objects = result.$objects;
  const rootIndex = result.$top.root.value;
  return {objects, configObj: objects[rootIndex]};
}

function getNSURLObj(objects: any[]): any {
  return objects.find((o: any) => o && typeof o === 'object' && 'NS.relative' in o);
}

describe('XCTestConfigurationEncoder', function () {
  let encoder: XCTestConfigurationEncoder;

  beforeEach(function () {
    encoder = new XCTestConfigurationEncoder();
  });

  describe('NSURL encoding', function () {
    it('should encode NSURL with null base', function () {
      const result = encoder.encode(createNSURL('file:///path/to/test.xctest'));
      const {objects} = getRootConfig(result);

      const nsUrlObj = getNSURLObj(objects);
      assert.notStrictEqual(nsUrlObj, undefined);
      assert.ok(nsUrlObj['NS.relative'] instanceof PlistUID);
      assert.ok(nsUrlObj['NS.base'] instanceof PlistUID);
      assert.strictEqual(nsUrlObj['NS.base'].value, 0);
      assert.strictEqual(objects[nsUrlObj['NS.relative'].value], 'file:///path/to/test.xctest');

      const classObj = objects.find((o: any) => o && typeof o === 'object' && o.$classname === 'NSURL');
      assert.notStrictEqual(classObj, undefined);
      assert.deepStrictEqual(classObj.$classes, ['NSURL', 'NSObject']);
    });

    it('should encode NSURL with base', function () {
      const result = encoder.encode(createNSURL('/relative/path', 'file:///base'));
      const {objects} = getRootConfig(result);

      const nsUrlObj = getNSURLObj(objects);
      assert.notStrictEqual(nsUrlObj, undefined);
      assert.notStrictEqual(nsUrlObj['NS.base'].value, 0);
      assert.strictEqual(objects[nsUrlObj['NS.base'].value], 'file:///base');
    });
  });

  describe('XCTestConfiguration encoding', function () {
    it('should have valid NSKeyedArchiver structure and expected classes', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///path/to/Runner.xctest',
        sessionIdentifier: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        targetApplicationBundleID: 'com.example.app',
        initializeForUITesting: true,
        reportResultsToIDE: true,
      });

      assert.strictEqual(result.$archiver, 'NSKeyedArchiver');
      assert.strictEqual(result.$version, 100000);
      assert.ok(Array.isArray(result.$objects));
      assert.ok('$top' in result);
      assert.ok('root' in result.$top);
      assert.ok(result.$top.root instanceof PlistUID);
      assert.strictEqual(result.$objects[0], '$null');

      const rootIndex = result.$top.root.value;
      assert.ok(rootIndex > 0);
      assert.ok(rootIndex < result.$objects.length);

      for (const className of ['XCTestConfiguration', 'NSUUID', 'NSURL']) {
        const classObj = result.$objects.find((o: any) => o && typeof o === 'object' && o.$classname === className);
        assert.notStrictEqual(classObj, undefined, `Missing class ${className}`);
      }
    });

    it('should handle null fields as $null references', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        targetApplicationBundleID: undefined, // omitted
        testsToRun: null, // explicit null
      });

      const {configObj} = getRootConfig(result);

      // testsToRun should be a PlistUID pointing to $null (index 0)
      assert.ok(configObj.testsToRun instanceof PlistUID);
      assert.strictEqual(configObj.testsToRun.value, 0);
    });

    it('should store booleans inline', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        initializeForUITesting: true,
        reportResultsToIDE: false,
      });

      const {configObj} = getRootConfig(result);

      // Booleans should be stored inline, not as PlistUID references
      assert.strictEqual(configObj.initializeForUITesting, true);
      assert.strictEqual(configObj.reportResultsToIDE, false);
    });

    it('should store non-primitive values as $objects entries referenced by PlistUID', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        targetApplicationBundleID: 'com.example.app',
      });

      const {objects, configObj} = getRootConfig(result);

      // formatVersion should be a PlistUID reference to another PlistUID object
      assert.ok(configObj.formatVersion instanceof PlistUID);
      const referencedValue = objects[configObj.formatVersion.value];
      assert.ok(referencedValue instanceof PlistUID);
      assert.strictEqual(referencedValue.value, 2);

      // targetApplicationBundleID should be a PlistUID reference to a string
      assert.ok(configObj.targetApplicationBundleID instanceof PlistUID);
      assert.strictEqual(objects[configObj.targetApplicationBundleID.value], 'com.example.app');
    });
  });

  describe('inherited NSUUID support', function () {
    it('should encode NSUUID via TestmanagerdEncoder inheritance', function () {
      const uuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const result = encoder.encode(createNSUUID(uuid));
      const objects = result.$objects;

      const nsUuidObj = objects.find((o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o);
      assert.notStrictEqual(nsUuidObj, undefined);
      assert.ok(nsUuidObj['NS.uuidbytes'] instanceof Buffer);
      assert.strictEqual(nsUuidObj['NS.uuidbytes'].equals(Buffer.from(uuid.replace(/-/g, ''), 'hex')), true);
    });
  });
});
