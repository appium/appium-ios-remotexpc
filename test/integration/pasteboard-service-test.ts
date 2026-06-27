import { expect } from 'chai';

import {
  GENERAL_PASTEBOARD,
  PasteboardService,
  type PasteboardItem,
} from '../../src/index.js';
import * as Services from '../../src/services.js';

describe('PasteboardService', function () {
  this.timeout(60000);

  let pasteboardService: PasteboardService | null = null;
  const udid = process.env.UDID || '';

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
    const original = await pasteboardService!.get();
    const originalPasteboard = original.pasteboard;
    const originalItems = Array.isArray(originalPasteboard?.items)
      ? originalPasteboard.items
      : [];
    const text = `appium-ios-remotexpc pasteboard ${Date.now()}`;

    try {
      await pasteboardService!.setText(text);

      expect(await pasteboardService!.getText()).to.equal(text);

      const raw = await pasteboardService!.get();
      expect(PasteboardService.extractText(raw)).to.equal(text);
    } finally {
      await pasteboardService!.set(
        originalItems as PasteboardItem[],
        GENERAL_PASTEBOARD,
        originalPasteboard?.sourceMetadata,
      );
    }
  });
});
