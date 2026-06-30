import { expect } from 'chai';

import { type PasteboardService } from '../../src/index.js';
import * as Services from '../../src/services.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

describe('PasteboardService', function () {
  this.timeout(60000);

  let pasteboardService: PasteboardService | null = null;
  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }

    pasteboardService = await Services.startPasteboardService(udid);
  });

  after(async function () {
    try {
      await pasteboardService?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('sets and gets UTF-8 text', async function () {
    const originalText = await pasteboardService!.getText();
    const text = `appium-ios-remotexpc pasteboard ${Date.now()}`;

    try {
      await pasteboardService!.setText(text);

      expect(await pasteboardService!.getText()).to.equal(text);
    } finally {
      if (originalText !== undefined) {
        await pasteboardService!.setText(originalText);
      }
    }
  });

  it('sets and gets URL text', async function () {
    const originalText = await pasteboardService!.getText();
    const url = `https://example.test/pasteboard/${Date.now()}`;

    try {
      await pasteboardService!.setUrl(url);

      // getUrl() returns a URL object; compare its string form.
      expect((await pasteboardService!.getUrl())?.toString()).to.equal(url);
    } finally {
      if (originalText !== undefined) {
        await pasteboardService!.setText(originalText);
      }
    }
  });

  it('sets and gets PNG image data', async function () {
    const originalText = await pasteboardService!.getText();

    try {
      await pasteboardService!.setImage(PNG_1X1);

      expect(await pasteboardService!.getImage()).to.deep.equal(PNG_1X1);
    } finally {
      if (originalText !== undefined) {
        await pasteboardService!.setText(originalText);
      }
    }
  });
});
