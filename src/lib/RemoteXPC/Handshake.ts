import { Socket } from 'net';

import { Http2Constants, XpcConstants } from './Constants.js';
import {
  DataFrame,
  HeadersFrame,
  SettingsFrame,
  WindowUpdateFrame,
} from './HandshakeFrames.js';
import { type XPCMessage, encodeMessage } from './XPCProtocol.js';

class Handshake {
  private _socket: Socket;
  private nextMessageId: { [channel: number]: number };

  constructor(socket: Socket) {
    // Socket must be non-null here
    this._socket = socket;
    this.nextMessageId = {
      [Http2Constants.ROOT_CHANNEL]: 0,
      [Http2Constants.REPLY_CHANNEL]: 0,
    };
  }

  async sendFrame(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this._socket.write(frame, (error: Error | null | undefined) => {
        if (error) reject('error: ' + error);
        else resolve();
      });
    });
  }

  async sendRequest(data: object): Promise<void> {
    const flags: number = XpcConstants.XPC_FLAGS_ALWAYS_SET;
    const requestMessage: XPCMessage = {
      flags: flags,
      id: BigInt(this.nextMessageId[Http2Constants.ROOT_CHANNEL]),
      body: data,
    };

    const encodedMessage: Buffer = encodeMessage(requestMessage);
    const dataFrame: DataFrame = new DataFrame(
      Http2Constants.ROOT_CHANNEL,
      encodedMessage,
      [],
    );
    await this.sendFrame(dataFrame.serialize());
  }

  async perform(): Promise<void> {
    // Step 1: Send HTTP/2 magic sequence.
    await new Promise<void>((resolve, reject) => {
      this._socket.write(Http2Constants.HTTP2_MAGIC, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Step 2: Send SETTINGS frame on stream 0.
    const settings: Record<number, number> = {
      [SettingsFrame.MAX_CONCURRENT_STREAMS]: 100,
      [SettingsFrame.INITIAL_WINDOW_SIZE]: 1048576,
    };
    const settingsFrame: SettingsFrame = new SettingsFrame(0, settings, []);
    await this.sendFrame(settingsFrame.serialize());

    // Step 3: Send WINDOW_UPDATE frame on stream 0.
    const windowUpdateFrame: WindowUpdateFrame = new WindowUpdateFrame(
      0,
      983041,
    );
    await this.sendFrame(windowUpdateFrame.serialize());

    // Step 4: Send a HEADERS frame on stream 1.
    const headersFrameRoot: HeadersFrame = new HeadersFrame(
      Http2Constants.ROOT_CHANNEL,
      Buffer.from(''),
      ['END_HEADERS'],
    );
    await this.sendFrame(headersFrameRoot.serialize());

    // Step 5: Send first DataFrame on stream 1 (empty payload).
    await this.sendRequest({});

    // Step 6: Send second DataFrame on stream 1 with specific flags.
    const dataMessage: XPCMessage = {
      flags: 0x0201,
      id: 0,
      body: null,
    };
    const encodedDataMessage: Buffer = encodeMessage(dataMessage);
    const dataFrame: DataFrame = new DataFrame(
      Http2Constants.ROOT_CHANNEL,
      encodedDataMessage,
      [],
    );
    await this.sendFrame(dataFrame.serialize());
    this.nextMessageId[Http2Constants.ROOT_CHANNEL]++;

    // Step 7: Send a HEADERS frame on stream 3.
    const headersFrameReply: HeadersFrame = new HeadersFrame(
      Http2Constants.REPLY_CHANNEL,
      Buffer.from(''),
      ['END_HEADERS'],
    );
    await this.sendFrame(headersFrameReply.serialize());

    // Step 8: Open REPLY_CHANNEL with INIT_HANDSHAKE flags.
    const replyMessage: XPCMessage = {
      flags:
        XpcConstants.XPC_FLAGS_ALWAYS_SET |
        XpcConstants.XPC_FLAGS_INIT_HANDSHAKE,
      id: 0,
      body: null,
    };
    const encodedReplyMessage: Buffer = encodeMessage(replyMessage);
    const replyDataFrame: DataFrame = new DataFrame(
      Http2Constants.REPLY_CHANNEL,
      encodedReplyMessage,
      [],
    );
    await this.sendFrame(replyDataFrame.serialize());
    this.nextMessageId[Http2Constants.REPLY_CHANNEL]++;

    // Step 9: Send SETTINGS ACK frame.
    const ackFrame: SettingsFrame = new SettingsFrame(0, null, ['ACK']);
    await this.sendFrame(ackFrame.serialize());
  }
}

export default Handshake;
