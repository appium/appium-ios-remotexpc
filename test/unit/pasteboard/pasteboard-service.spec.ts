import { expect } from 'chai';
import { EventEmitter } from 'node:events';

import { decodeMessage } from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type { XPCDictionary } from '../../../src/lib/types.js';
import { PasteboardService } from '../../../src/services/ios/pasteboard/index.js';

type Responder = (sentBody: XPCDictionary) => XPCDictionary | null;

class FakeTransport extends EventEmitter {
  isConnected = true;
  closeCalls = 0;
  readonly sentBodies: XPCDictionary[] = [];

  constructor(private responder: Responder) {
    super();
  }

  sendDataFrame(payload: Buffer): void {
    const { message } = decodeMessage(payload);
    const body = message.body as XPCDictionary;
    this.sentBodies.push(body);
    const reply = this.responder(body);
    if (reply) {
      queueMicrotask(() => this.emit('message', reply));
    }
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

class TestPasteboardService extends PasteboardService {
  constructor(readonly fake: FakeTransport) {
    super('test-udid');
  }

  protected async createTransport(): Promise<any> {
    return this.fake;
  }
}

describe('PasteboardService', function () {
  describe('requests', function () {
    it('getText sends PULL with the default allResolved data policy', async function () {
      const reply = {
        command: 'PULL_REPLY',
        pasteboard: { items: [buildTextItem('hello')] },
      };
      const fake = new FakeTransport(() => reply);
      const service = new TestPasteboardService(fake);

      const result = await service.getText();

      expect(fake.sentBodies[0]).to.deep.equal({
        command: 'PULL',
        pasteboardName: 'general',
        dataPolicy: { allResolved: {} },
      });
      expect(fake.sentBodies[0]).not.to.have.property(
        'CoreDevice.featureIdentifier',
      );
      expect(result).to.equal('hello');
    });

    it('setText sends SET with a text item', async function () {
      const reply = {
        command: 'SET_REPLY',
        pasteboard: { items: [] as XPCDictionary[] },
      };
      const fake = new FakeTransport(() => reply);
      const service = new TestPasteboardService(fake);

      await service.setText('hello');

      expect(fake.sentBodies[0]).to.deep.equal({
        command: 'SET',
        pasteboardName: 'general',
        items: [buildTextItem('hello')],
      });
    });

    it('getText extracts text from the raw PULL reply', async function () {
      const fake = new FakeTransport(() => ({
        command: 'PULL_REPLY',
        pasteboard: { items: [buildTextItem('hello')] },
      }));
      const service = new TestPasteboardService(fake);

      expect(await service.getText()).to.equal('hello');
    });

    it('setUrl sends SET with URL and text UTIs', async function () {
      const fake = new FakeTransport(() => ({ command: 'SET_REPLY' }));
      const service = new TestPasteboardService(fake);

      await service.setUrl('https://example.test/path');

      expect(fake.sentBodies[0]).to.deep.equal({
        command: 'SET',
        pasteboardName: 'general',
        items: [buildUrlItem('https://example.test/path')],
      });
    });

    it('getUrl extracts URL text from the raw PULL reply', async function () {
      const fake = new FakeTransport(() => ({
        command: 'PULL_REPLY',
        pasteboard: { items: [buildUrlItem('https://example.test/path')] },
      }));
      const service = new TestPasteboardService(fake);

      expect((await service.getUrl())?.toString()).to.equal(
        'https://example.test/path',
      );
    });

    it('setImage sends SET with a PNG payload', async function () {
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const fake = new FakeTransport(() => ({ command: 'SET_REPLY' }));
      const service = new TestPasteboardService(fake);

      await service.setImage(image);

      expect(fake.sentBodies[0]).to.deep.equal({
        command: 'SET',
        pasteboardName: 'general',
        items: [buildImageItem(image)],
      });
    });

    it('getImage extracts image data from the raw PULL reply', async function () {
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const fake = new FakeTransport(() => ({
        command: 'PULL_REPLY',
        pasteboard: { items: [buildImageItem(image)] },
      }));
      const service = new TestPasteboardService(fake);

      expect(await service.getImage()).to.deep.equal(image);
    });
  });
});

function buildTextItem(text: string): XPCDictionary {
  const payload = Buffer.from(text, 'utf8');
  return {
    types: ['public.utf8-plain-text', 'public.plain-text', 'public.text'],
    data: {
      'public.utf8-plain-text': { data: Buffer.from(payload) },
      'public.plain-text': { data: Buffer.from(payload) },
      'public.text': { data: Buffer.from(payload) },
    },
  };
}

function buildUrlItem(url: string): XPCDictionary {
  const payload = Buffer.from(url, 'utf8');
  return {
    types: [
      'public.url',
      'public.utf8-plain-text',
      'public.plain-text',
      'public.text',
    ],
    data: {
      'public.url': { data: Buffer.from(payload) },
      'public.utf8-plain-text': { data: Buffer.from(payload) },
      'public.plain-text': { data: Buffer.from(payload) },
      'public.text': { data: Buffer.from(payload) },
    },
  };
}

function buildImageItem(image: Buffer): XPCDictionary {
  return {
    types: ['public.png'],
    data: {
      'public.png': { data: Buffer.from(image) },
    },
  };
}
