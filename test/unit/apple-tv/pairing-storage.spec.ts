import { expect } from 'chai';
import esmock from 'esmock';
import { describe, it } from 'node:test';

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('PairingStorage', function () {
  it('discovers Apple TV pair records stored with slugified Strongbox filenames', async function () {
    const container = '/tmp/appium-ios-remotexpc';
    const box = {
      container,
      listItems: async () => [
        {
          name: 'appletv-pairing-device-1',
          id: `${container}/appletv-pairing-device-1`,
        },
        {
          name: 'appletv_pairing_device-2',
          id: `${container}/appletv-pairing-device-2`,
        },
        {
          name: 'pair-record-device-3',
          id: `${container}/pair-record-device-3`,
        },
      ],
    };

    const { PairingStorage } = await esmock(
      '../../../src/lib/apple-tv/storage/pairing-storage.js',
      {
        '@appium/strongbox': {
          strongbox: () => box,
          BaseItem: class {
            id: string;

            constructor(
              public readonly name: string,
              parent: { container: string },
            ) {
              this.id = `${parent.container}/${slugify(name)}`;
            }
          },
        },
      },
    );

    const storage = new PairingStorage({
      timeout: 1,
      discoveryTimeout: 1,
      maxRetries: 1,
    });

    expect(await storage.getAvailableDeviceIds()).to.deep.equal([
      'device-1',
      'device-2',
    ]);
  });
});
