import { expect } from 'chai';
import { EventEmitter } from 'node:events';

import { decodeMessage } from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type { XPCDictionary } from '../../../src/lib/types.js';
import {
  GENERAL_PASTEBOARD,
  PASTEBOARD_COMMAND,
  PASTEBOARD_POLICY,
  PASTEBOARD_UTI,
  PasteboardService,
} from '../../../src/services/ios/pasteboard/index.js';

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
  describe('helpers', function () {
    it('buildTextItem produces standard text UTIs with Buffer payloads', function () {
      const item = PasteboardService.buildTextItem('hello');

      expect(item.types).to.deep.equal([
        PASTEBOARD_UTI.UTF8_PLAIN_TEXT,
        PASTEBOARD_UTI.PLAIN_TEXT,
        PASTEBOARD_UTI.TEXT,
      ]);
      for (const uti of item.types) {
        const datum = item.data[uti] as XPCDictionary;
        expect(Buffer.isBuffer(datum.data)).to.equal(true);
        expect((datum.data as Buffer).toString('utf8')).to.equal('hello');
      }
    });

    it('buildDataItem produces one UTI with a Buffer payload', function () {
      const item = PasteboardService.buildDataItem(
        PASTEBOARD_UTI.URL,
        'https://example.test',
      );

      expect(item.types).to.deep.equal([PASTEBOARD_UTI.URL]);
      const datum = item.data[PASTEBOARD_UTI.URL] as XPCDictionary;
      expect(Buffer.isBuffer(datum.data)).to.equal(true);
      expect((datum.data as Buffer).toString('utf8')).to.equal(
        'https://example.test',
      );
    });

    it('extractText handles whole replies and bare snapshots', function () {
      const item = PasteboardService.buildTextItem('from snapshot');
      const snapshot = { items: [item] };
      const reply = { command: 'PULL_REPLY', pasteboard: snapshot };

      expect(PasteboardService.extractText(reply)).to.equal('from snapshot');
      expect(PasteboardService.extractText(snapshot)).to.equal('from snapshot');
      expect(PasteboardService.extractText({ items: [] })).to.equal(undefined);
    });
  });

  describe('requests', function () {
    it('get sends PULL with the default allResolved data policy', async function () {
      const reply = {
        command: 'PULL_REPLY',
        pasteboard: { items: [] as XPCDictionary[] },
      };
      const fake = new FakeTransport(() => reply);
      const service = new TestPasteboardService(fake);

      const result = await service.get();

      expect(fake.sentBodies[0]).to.deep.equal({
        command: PASTEBOARD_COMMAND.PULL,
        pasteboardName: GENERAL_PASTEBOARD,
        dataPolicy: PASTEBOARD_POLICY.ALL_RESOLVED,
      });
      expect(fake.sentBodies[0]).not.to.have.property(
        'CoreDevice.featureIdentifier',
      );
      expect(result).to.deep.equal(reply);
    });

    it('setText sends SET with a text item', async function () {
      const reply = {
        command: 'SET_REPLY',
        pasteboard: { items: [] as XPCDictionary[] },
      };
      const fake = new FakeTransport(() => reply);
      const service = new TestPasteboardService(fake);

      const result = await service.setText('hello');

      expect(fake.sentBodies[0]).to.deep.equal({
        command: PASTEBOARD_COMMAND.SET,
        pasteboardName: GENERAL_PASTEBOARD,
        items: [PasteboardService.buildTextItem('hello')],
      });
      expect(result).to.deep.equal(reply);
    });

    it('getText extracts text from the raw PULL reply', async function () {
      const fake = new FakeTransport(() => ({
        command: 'PULL_REPLY',
        pasteboard: { items: [PasteboardService.buildTextItem('hello')] },
      }));
      const service = new TestPasteboardService(fake);

      expect(await service.getText()).to.equal('hello');
    });
  });
});
