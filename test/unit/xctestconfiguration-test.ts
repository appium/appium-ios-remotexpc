import { expect } from 'chai';

import { PlistUID } from '../../src/lib/plist/index.js';
import {
  XCTestConfigurationEncoder,
  createNSURL,
  createNSUUID,
} from '../../src/services/ios/testmanagerd/xctestconfiguration.js';

function getRootConfig(result: any): { objects: any[]; configObj: any } {
  const objects = result.$objects;
  const rootIndex = result.$top.root.value;
  return { objects, configObj: objects[rootIndex] };
}

function getNSURLObj(objects: any[]): any {
  return objects.find(
    (o: any) => o && typeof o === 'object' && 'NS.relative' in o,
  );
}

describe('XCTestConfigurationEncoder', function () {
  let encoder: XCTestConfigurationEncoder;

  beforeEach(function () {
    encoder = new XCTestConfigurationEncoder();
  });

  describe('NSURL encoding', function () {
    it('should encode NSURL with null base', function () {
      const result = encoder.encode(createNSURL('file:///path/to/test.xctest'));
      const { objects } = getRootConfig(result);

      const nsUrlObj = getNSURLObj(objects);
      expect(nsUrlObj).to.not.be.undefined;
      expect(nsUrlObj['NS.relative']).to.be.instanceOf(PlistUID);
      expect(nsUrlObj['NS.base']).to.be.instanceOf(PlistUID);
      expect(nsUrlObj['NS.base'].value).to.equal(0);
      expect(objects[nsUrlObj['NS.relative'].value]).to.equal(
        'file:///path/to/test.xctest',
      );

      const classObj = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSURL',
      );
      expect(classObj).to.not.be.undefined;
      expect(classObj.$classes).to.deep.equal(['NSURL', 'NSObject']);
    });

    it('should encode NSURL with base', function () {
      const result = encoder.encode(
        createNSURL('/relative/path', 'file:///base'),
      );
      const { objects } = getRootConfig(result);

      const nsUrlObj = getNSURLObj(objects);
      expect(nsUrlObj).to.not.be.undefined;
      expect(nsUrlObj['NS.base'].value).to.not.equal(0);
      expect(objects[nsUrlObj['NS.base'].value]).to.equal('file:///base');
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

      expect(result).to.have.property('$archiver', 'NSKeyedArchiver');
      expect(result).to.have.property('$version', 100000);
      expect(result).to.have.property('$objects').that.is.an('array');
      expect(result).to.have.property('$top');
      expect(result.$top).to.have.property('root');
      expect(result.$top.root).to.be.instanceOf(PlistUID);
      expect(result.$objects[0]).to.equal('$null');

      const rootIndex = result.$top.root.value;
      expect(rootIndex).to.be.greaterThan(0);
      expect(rootIndex).to.be.lessThan(result.$objects.length);

      for (const className of ['XCTestConfiguration', 'NSUUID', 'NSURL']) {
        const classObj = result.$objects.find(
          (o: any) => o && typeof o === 'object' && o.$classname === className,
        );
        expect(classObj, `Missing class ${className}`).to.not.be.undefined;
      }
    });

    it('should handle null fields as $null references', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        targetApplicationBundleID: undefined, // omitted
        testsToRun: null, // explicit null
      });

      const { configObj } = getRootConfig(result);

      // testsToRun should be a PlistUID pointing to $null (index 0)
      expect(configObj.testsToRun).to.be.instanceOf(PlistUID);
      expect(configObj.testsToRun.value).to.equal(0);
    });

    it('should store booleans inline', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        initializeForUITesting: true,
        reportResultsToIDE: false,
      });

      const { configObj } = getRootConfig(result);

      // Booleans should be stored inline, not as PlistUID references
      expect(configObj.initializeForUITesting).to.equal(true);
      expect(configObj.reportResultsToIDE).to.equal(false);
    });

    it('should store non-primitive values as $objects entries referenced by PlistUID', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
        targetApplicationBundleID: 'com.example.app',
      });

      const { objects, configObj } = getRootConfig(result);

      // formatVersion should be a PlistUID reference to another PlistUID object
      expect(configObj.formatVersion).to.be.instanceOf(PlistUID);
      const referencedValue = objects[configObj.formatVersion.value];
      expect(referencedValue).to.be.instanceOf(PlistUID);
      expect(referencedValue.value).to.equal(2);

      // targetApplicationBundleID should be a PlistUID reference to a string
      expect(configObj.targetApplicationBundleID).to.be.instanceOf(PlistUID);
      expect(objects[configObj.targetApplicationBundleID.value]).to.equal(
        'com.example.app',
      );
    });
  });

  describe('inherited NSUUID support', function () {
    it('should encode NSUUID via TestmanagerdEncoder inheritance', function () {
      const uuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const result = encoder.encode(createNSUUID(uuid));
      const objects = result.$objects;

      const nsUuidObj = objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o,
      );
      expect(nsUuidObj).to.not.be.undefined;
      expect(nsUuidObj['NS.uuidbytes']).to.be.instanceOf(Buffer);
      expect(
        nsUuidObj['NS.uuidbytes'].equals(
          Buffer.from(uuid.replace(/-/g, ''), 'hex'),
        ),
      ).to.be.true;
    });
  });
});
