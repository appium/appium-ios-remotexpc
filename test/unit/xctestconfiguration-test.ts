import { expect } from 'chai';

import { PlistUID } from '../../src/lib/plist/index.js';
import {
  XCTestConfigurationEncoder,
  createNSURL,
  createNSUUID,
} from '../../src/services/ios/testmanagerd/xctestconfiguration.js';

describe('XCTestConfigurationEncoder', function () {
  let encoder: XCTestConfigurationEncoder;

  beforeEach(function () {
    encoder = new XCTestConfigurationEncoder();
  });

  describe('NSUUID encoding', function () {
    it('should encode NSUUID correctly', function () {
      const uuid = '12345678-1234-1234-1234-123456789ABC';
      const uuidMarker = createNSUUID(uuid);

      const result = encoder.encode(uuidMarker);

      expect(result).to.have.property('$archiver', 'NSKeyedArchiver');
      expect(result).to.have.property('$version', 100000);
      expect(result).to.have.property('$objects').that.is.an('array');

      // Find the NSUUID object in $objects
      const objects = result.$objects;
      const nsUuidObj = objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o,
      );
      expect(nsUuidObj).to.not.be.undefined;
      expect(nsUuidObj['NS.uuidbytes']).to.be.instanceOf(Buffer);
      expect(nsUuidObj['NS.uuidbytes'].length).to.equal(16);

      // Verify the UUID bytes match
      const expectedBytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
      expect(nsUuidObj['NS.uuidbytes'].equals(expectedBytes)).to.be.true;

      // Verify class definition
      const classObj = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSUUID',
      );
      expect(classObj).to.not.be.undefined;
      expect(classObj.$classes).to.deep.equal(['NSUUID', 'NSObject']);
    });
  });

  describe('NSURL encoding', function () {
    it('should encode NSURL correctly', function () {
      const url = createNSURL('file:///path/to/test.xctest');

      const result = encoder.encode(url);

      const objects = result.$objects;

      // Find the NSURL object
      const nsUrlObj = objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.relative' in o,
      );
      expect(nsUrlObj).to.not.be.undefined;
      expect(nsUrlObj['NS.relative']).to.be.instanceOf(PlistUID);
      expect(nsUrlObj['NS.base']).to.be.instanceOf(PlistUID);

      // base should point to $null (index 0) since base is null
      expect(nsUrlObj['NS.base'].value).to.equal(0);

      // Verify the relative URL string is in objects
      const relativeUrl = objects[nsUrlObj['NS.relative'].value];
      expect(relativeUrl).to.equal('file:///path/to/test.xctest');

      // Verify class definition
      const classObj = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSURL',
      );
      expect(classObj).to.not.be.undefined;
    });

    it('should encode NSURL with base correctly', function () {
      const url = createNSURL('/relative/path', 'file:///base');

      const result = encoder.encode(url);

      const objects = result.$objects;
      const nsUrlObj = objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.relative' in o,
      );
      expect(nsUrlObj).to.not.be.undefined;

      // base should not point to $null since we have a base URL
      expect(nsUrlObj['NS.base'].value).to.not.equal(0);
    });
  });

  describe('XCTestConfiguration encoding', function () {
    it('should encode full XCTestConfiguration', function () {
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

      const objects = result.$objects;

      // Should have XCTestConfiguration class
      const xcTestConfigClass = objects.find(
        (o: any) =>
          o && typeof o === 'object' && o.$classname === 'XCTestConfiguration',
      );
      expect(xcTestConfigClass).to.not.be.undefined;

      // Should have NSUUID class (for sessionIdentifier)
      const nsUuidClass = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSUUID',
      );
      expect(nsUuidClass).to.not.be.undefined;

      // Should have NSURL class (for testBundleURL)
      const nsUrlClass = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSURL',
      );
      expect(nsUrlClass).to.not.be.undefined;
    });

    it('should produce valid NSKeyedArchiver format', function () {
      const result = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///test.xctest',
      });

      // Verify root structure
      expect(result.$top).to.have.property('root');
      expect(result.$top.root).to.be.instanceOf(PlistUID);

      // $objects[0] should be $null
      expect(result.$objects[0]).to.equal('$null');

      // Root object should be reachable
      const rootIndex = result.$top.root.value;
      expect(rootIndex).to.be.greaterThan(0);
      expect(rootIndex).to.be.lessThan(result.$objects.length);
    });
  });
});
