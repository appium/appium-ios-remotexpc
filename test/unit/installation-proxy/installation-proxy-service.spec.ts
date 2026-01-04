import { expect } from 'chai';

import {
  DEFAULT_RETURN_ATTRIBUTES,
  SIZE_ATTRIBUTES,
} from '../../../src/services/ios/installation-proxy/constants.js';
import { InstallationProxyService } from '../../../src/services/ios/installation-proxy/index.js';

describe('InstallationProxyService', function () {
  describe('InstallationProxyService instantiation', function () {
    it('should create a service with valid address', function () {
      const service = new InstallationProxyService(['127.0.0.1', 12345]);
      expect(service).to.be.instanceOf(InstallationProxyService);
    });

    it('should have the correct RSD service name', function () {
      expect(InstallationProxyService.RSD_SERVICE_NAME).to.equal(
        'com.apple.mobile.installation_proxy.shim.remote',
      );
    });
  });

  describe('Constants', function () {
    it('should have correct default return attributes', function () {
      expect(DEFAULT_RETURN_ATTRIBUTES).to.deep.equal([
        'CFBundleIdentifier',
        'CFBundleName',
        'CFBundleDisplayName',
        'CFBundleVersion',
        'CFBundleShortVersionString',
        'ApplicationType',
      ]);
    });

    it('should have correct size attributes', function () {
      expect(SIZE_ATTRIBUTES).to.deep.equal([
        'CFBundleIdentifier',
        'StaticDiskUsage',
        'DynamicDiskUsage',
      ]);
    });
  });
});
