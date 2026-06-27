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
