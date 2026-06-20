import { expect } from 'chai';

import { buildCoreDeviceInvokeRequest } from '../../../src/services/ios/core-device/base.js';
import { ScreenCaptureService } from '../../../src/services/ios/screen-capture/index.js';

describe('ScreenCaptureService', function () {
  it('builds the CoreDevice screenshot invoke request', function () {
    const request = buildCoreDeviceInvokeRequest(
      'com.apple.coredevice.feature.capturescreenshot',
      {
        displayUniqueID: null,
        requestedFormat: 'png',
      },
      'com.apple.coredevice.action.capturescreenshot',
    );

    expect(request).to.include({
      'CoreDevice.CoreDeviceDDIProtocolVersion': 2,
      'CoreDevice.featureIdentifier':
        'com.apple.coredevice.feature.capturescreenshot',
      'CoreDevice.actionIdentifier':
        'com.apple.coredevice.action.capturescreenshot',
    });
    expect(request['CoreDevice.input']).to.deep.equal({
      displayUniqueID: null,
      requestedFormat: 'png',
    });
    expect(request['CoreDevice.coreDeviceVersion']).to.deep.equal({
      components: [629n, 3n],
      originalComponentsCount: 2,
      stringValue: '629.3',
    });
    expect(request['CoreDevice.deviceIdentifier']).to.be.a('string');
    expect(request['CoreDevice.invocationIdentifier']).to.be.a('string');
  });

  it('normalizes captureScreenshot options and returns the image payload', async function () {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sentRequests: unknown[] = [];
    const service = new ScreenCaptureService('test-udid');

    (service as any).invoke = async (
      featureIdentifier: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<unknown> => {
      sentRequests.push({ featureIdentifier, input, options });
      return {
        image,
        displayUniqueID: 'main',
        imageFormat: 'png',
      };
    };

    const result = await service.captureScreenshot({
      displayUniqueId: 'main',
      requestedFormat: 'png',
      timeout: 1234,
    });

    expect(result.image).to.equal(image);
    expect(sentRequests).to.deep.equal([
      {
        featureIdentifier: 'com.apple.coredevice.feature.capturescreenshot',
        input: {
          displayUniqueID: 'main',
          requestedFormat: 'png',
        },
        options: {
          actionIdentifier: 'com.apple.coredevice.action.capturescreenshot',
          timeout: 1234,
        },
      },
    ]);
  });
});
