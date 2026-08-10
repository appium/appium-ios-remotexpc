import net from 'node:net';

import {getLogger} from '../../../lib/logger.js';
import {createBinaryPlist} from '../../../lib/plist/binary-plist-creator.js';
import {parseBinaryPlist} from '../../../lib/plist/binary-plist-parser.js';
import {createPlist} from '../../../lib/plist/plist-creator.js';
import {BaseService, stripSSL} from '../base-service.js';
import {ChannelFragmenter} from '../dvt/channel-fragmenter.js';
import {DTXMessage, DTX_CONSTANTS, MessageAux} from '../dvt/dtx-message.js';
import {decodeNSKeyedArchiver} from '../dvt/nskeyedarchiver-decoder.js';
import {NSKeyedArchiverEncoder} from '../dvt/nskeyedarchiver-encoder.js';
import {AxPoint, archiveAxPoint} from './ax-values.js';

const log = getLogger('AxAuditDtx');

/** First four bytes of a DTX message header (`0x1f3d5b79`, little-endian). */
const DTX_MAGIC = Buffer.from([0x79, 0x5b, 0x3d, 0x1f]);

/** The accessibility audit daemon speaks entirely on the DTX control channel. */
const CONTROL_CHANNEL = 0;

/** Options for {@link AxAuditDtxTransport.invoke}. */
export interface InvokeOptions {
  /** How long to wait for the reply, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
}

/**
 * DTX transport for the accessibility audit daemon
 * (`com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote`).
 *
 * This service is a DTX endpoint like the DVT instruments hub, but its RSD shim
 * needs a different opening than {@link DVTSecureSocketProxyService}: a single
 * `RSDCheckin` is answered by **two** framed plists — `{RSDCheckin}` then
 * `{StartService}` — and only then does the raw DTX stream begin. Consuming both
 * is the whole difference; reading just one leaves the second plist's bytes in
 * front of the DTX stream and every later frame misparses. This was verified by
 * packet-capturing Xcode's own Accessibility Inspector session.
 *
 * The exchange is also bidirectional: the device sends its own
 * `_notifyOfPublishedCapabilities:` and a `hostApiVersion` request (neither must
 * be answered for the read calls to work, verified live), and it delivers some
 * results as calls back to the host rather than as replies — e.g. an audit's
 * issues. Inbound calls are routed to {@link waitForInbound} waiters by selector
 * and otherwise dropped.
 *
 * Reuses the DTX primitives from `../dvt/` unchanged — frame headers, the
 * auxiliary `DTXPrimitiveArray` encoding, fragment reassembly, and
 * NSKeyedArchiver coding — so this only owns the connection lifecycle and the
 * request/reply dispatch.
 */
export class AxAuditDtxTransport extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote';

  private socket: net.Socket | null = null;
  private readBuffer = Buffer.alloc(0);
  private readWaiter: (() => void) | null = null;
  private closed = false;
  private closeError: Error | undefined;

  private nextMessageId = 1;
  private readonly fragmenters = new Map<number, ChannelFragmenter>();
  private readonly pendingReplies = new Map<
    number,
    {resolve: (value: unknown) => void; reject: (error: Error) => void}
  >();
  private readonly inboundWaiters = new Map<string, Array<(args: unknown[]) => void>>();
  private readonly inboundListeners = new Map<string, Array<(args: unknown[]) => void>>();

  private constructor(udid: string) {
    super(udid);
    this.fragmenters.set(CONTROL_CHANNEL, new ChannelFragmenter());
  }

  /**
   * Connects to the daemon, performs the checkin + StartService handshake,
   * reaches the DTX phase, and publishes host capabilities.
   *
   * @param udid Target device UDID.
   */
  static async connect(udid: string): Promise<AxAuditDtxTransport> {
    const transport = new AxAuditDtxTransport(udid);
    await transport.open();
    return transport;
  }

  private async open(): Promise<void> {
    // A raw socket on purpose: this protocol interleaves length-prefixed plists
    // and raw DTX on one stream, so it cannot share ServiceConnection's plist
    // pipeline (which would consume the checkin reply before the DTX reader sees
    // it). Only the address resolution is reused.
    const [host, port] = await this.resolveServiceAddress(AxAuditDtxTransport.RSD_SERVICE_NAME);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const created = net.createConnection({host, port, family: 6}, () => {
        created.setKeepAlive(true);
        resolve(created);
      });
      created.once('error', reject);
    });
    stripSSL(socket);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose(new Error('Accessibility audit connection closed')));
    socket.on('error', (error: Error) => this.onClose(error));
    this.socket = socket;

    await this.performCheckin();
    await this.publishCapabilities();
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    const waiter = this.readWaiter;
    if (waiter) {
      this.readWaiter = null;
      waiter();
    }
  }

  private onClose(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    const waiter = this.readWaiter;
    if (waiter) {
      this.readWaiter = null;
      waiter();
    }
    for (const pending of this.pendingReplies.values()) {
      pending.reject(error);
    }
    this.pendingReplies.clear();
  }

  /** Waits until at least `length` bytes are buffered, then returns them without consuming. */
  private async peek(length: number): Promise<Buffer> {
    while (this.readBuffer.length < length) {
      if (this.closed) {
        throw this.closeError ?? new Error('Connection closed');
      }
      await new Promise<void>((resolve) => {
        this.readWaiter = resolve;
      });
    }
    return this.readBuffer.subarray(0, length);
  }

  /** Reads and consumes exactly `length` bytes. */
  private async readExact(length: number): Promise<Buffer> {
    const data = await this.peek(length);
    const copy = Buffer.from(data);
    this.readBuffer = this.readBuffer.subarray(length);
    return copy;
  }

  private write(buffer: Buffer): void {
    if (!this.socket || this.closed) {
      throw this.closeError ?? new Error('Accessibility audit connection is not open');
    }
    this.socket.write(buffer);
  }

  /**
   * Sends `RSDCheckin` and consumes every framed plist the daemon returns until
   * the DTX stream begins. On iOS 27 that is `{RSDCheckin}` then `{StartService}`.
   */
  private async performCheckin(): Promise<void> {
    const requestXml = createPlist({
      Label: 'appium-internal',
      ProtocolVersion: '2',
      Request: 'RSDCheckin',
    });
    const body = Buffer.from(String(requestXml), 'utf8');
    const framed = Buffer.alloc(4 + body.length);
    framed.writeUInt32BE(body.length, 0);
    body.copy(framed, 4);
    this.write(framed);

    // Plists are length-prefixed (4-byte big-endian); the DTX stream is not, so
    // the magic marks the boundary.
    for (;;) {
      const head = await this.peek(4);
      if (head.equals(DTX_MAGIC)) {
        return;
      }
      const length = head.readUInt32BE(0);
      await this.readExact(4);
      const plist = await this.readExact(length);
      const request = plist.toString('utf8').match(/<key>Request<\/key>\s*<string>([^<]*)</);
      log.debug(`Checkin plist consumed: ${request ? request[1] : '(unrecognized)'}`);
    }
  }

  /**
   * Reassembles one complete DTX message from the socket, handling multi-fragment
   * messages the same way {@link DVTSecureSocketProxyService} does.
   */
  private async recvMessage(): Promise<{
    channel: number;
    identifier: number;
    conversationIndex: number;
    payload: Buffer;
  }> {
    for (;;) {
      const header = DTXMessage.parseMessageHeader(await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE));
      const channel = Math.abs(header.channelCode);
      let fragmenter = this.fragmenters.get(channel);
      if (!fragmenter) {
        fragmenter = new ChannelFragmenter();
        this.fragmenters.set(channel, fragmenter);
      }
      // The first fragment of a multi-fragment message is a header-only marker.
      if (header.fragmentCount > 1 && header.fragmentId === 0) {
        continue;
      }
      const fragment = await this.readExact(header.length);
      fragmenter.addFragment(header, fragment);
      const message = fragmenter.get();
      if (message) {
        return {
          channel,
          identifier: header.identifier,
          conversationIndex: header.conversationIndex,
          payload: message,
        };
      }
    }
  }

  /**
   * Splits a reassembled payload into its object (the return value on a reply,
   * or the selector on an inbound call) and its decoded auxiliary arguments.
   */
  private decodePayload(payload: Buffer): {object: unknown; args: unknown[]} {
    const payloadHeader = DTXMessage.parsePayloadHeader(payload);
    const compression = (payloadHeader.flags & 0xff000) >> 12;
    if (compression !== 0) {
      throw new Error(`Unsupported DTX compression type ${compression}`);
    }
    const body = payload.subarray(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE);
    const auxBuffer = body.subarray(0, payloadHeader.auxiliaryLength);
    const args = parseAuxiliary(auxBuffer);

    const objectSize = Number(payloadHeader.totalLength) - payloadHeader.auxiliaryLength;
    const objectData =
      objectSize > 0 ? body.subarray(payloadHeader.auxiliaryLength, payloadHeader.auxiliaryLength + objectSize) : null;
    const object = objectData ? decodeNSKeyedArchiver(parseBinaryPlist(objectData)) : null;
    return {object, args};
  }

  /** The single read loop; dispatches replies to callers and inbound calls to waiters. */
  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const message = await this.recvMessage();
        const {object, args} = this.decodePayload(message.payload);
        if (message.conversationIndex === 1) {
          const pending = this.pendingReplies.get(message.identifier);
          if (pending) {
            this.pendingReplies.delete(message.identifier);
            pending.resolve(object);
          } else {
            log.debug(`Reply for unknown id ${message.identifier} ignored`);
          }
          continue;
        }
        // Inbound call from the device. The object is the selector; the args
        // carry the payload (e.g. audit issues). Deliver it to a waiter if one
        // is registered, otherwise drop it — the device does not require a reply
        // for the read flows this transport supports.
        const selector = typeof object === 'string' ? object : '';
        const listeners = selector ? this.inboundListeners.get(selector) : undefined;
        for (const listener of listeners ?? []) {
          listener(args);
        }
        const waiters = selector ? this.inboundWaiters.get(selector) : undefined;
        if (waiters && waiters.length > 0) {
          for (const waiter of waiters.splice(0)) {
            waiter(args);
          }
        } else if (!listeners || listeners.length === 0) {
          log.debug(`Inbound ${selector || 'message'} dropped (${args.length} arg(s))`);
        }
      }
    } catch (error) {
      this.onClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Subscribes to every inbound call with the given selector.
   *
   * Unlike {@link waitForInbound}, which resolves once, this stays registered —
   * the device streams some results as a sequence of calls (an audit reports each
   * issue via its own `hostFoundAuditIssue:`).
   *
   * @param selector The inbound selector to listen for.
   * @param listener Receives the call's decoded arguments.
   * @returns A function that removes the listener.
   */
  onInbound(selector: string, listener: (args: unknown[]) => void): () => void {
    const listeners = this.inboundListeners.get(selector) ?? [];
    listeners.push(listener);
    this.inboundListeners.set(selector, listeners);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  }

  /**
   * Resolves with the arguments of the next inbound call whose selector matches.
   *
   * The device delivers some results as calls back to the host rather than as
   * replies — e.g. an audit's issues arrive as
   * `hostDeviceDidCompleteAuditCategoriesWithAuditIssues:`.
   *
   * @param selector The inbound selector to wait for.
   * @param timeoutMs How long to wait before rejecting. Defaults to 60000.
   */
  waitForInbound(selector: string, timeoutMs = 60000): Promise<unknown[]> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('Connection closed'));
    }
    return new Promise<unknown[]>((resolve, reject) => {
      const waiters = this.inboundWaiters.get(selector) ?? [];
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onArgs);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for inbound ${selector}`));
      }, timeoutMs);
      const onArgs = (args: unknown[]): void => {
        clearTimeout(timer);
        resolve(args);
      };
      waiters.push(onArgs);
      this.inboundWaiters.set(selector, waiters);
    });
  }

  private buildFrame(
    selector: string | null,
    aux: MessageAux | null,
    expectsReply: boolean,
    identifier: number,
  ): Buffer {
    const auxBuffer = aux ? buildAuxiliaryData(aux) : Buffer.alloc(0);
    const selectorBuffer =
      selector === null ? Buffer.alloc(0) : createBinaryPlist(new NSKeyedArchiverEncoder().encode(selector));
    let flags = DTX_CONSTANTS.INSTRUMENTS_MESSAGE_TYPE;
    if (expectsReply) {
      flags |= DTX_CONSTANTS.EXPECTS_REPLY_MASK;
    }
    const payloadHeader = DTXMessage.buildPayloadHeader({
      flags,
      auxiliaryLength: auxBuffer.length,
      totalLength: BigInt(auxBuffer.length + selectorBuffer.length),
    });
    const messageHeader = DTXMessage.buildMessageHeader({
      magic: DTX_CONSTANTS.MESSAGE_HEADER_MAGIC,
      cb: DTX_CONSTANTS.MESSAGE_HEADER_SIZE,
      fragmentId: 0,
      fragmentCount: 1,
      length: DTX_CONSTANTS.PAYLOAD_HEADER_SIZE + auxBuffer.length + selectorBuffer.length,
      identifier,
      conversationIndex: 0,
      channelCode: CONTROL_CHANNEL,
      expectsReply: expectsReply ? 1 : 0,
    });
    return Buffer.concat([messageHeader, payloadHeader, auxBuffer, selectorBuffer]);
  }

  /** Publishes host capabilities and starts the read loop, matching Xcode's opening. */
  private async publishCapabilities(): Promise<void> {
    const aux = new MessageAux();
    aux.appendObj({
      'com.apple.private.DTXBlockCompression': 0,
      'com.apple.private.DTXConnection': 1,
    });
    this.write(this.buildFrame('_notifyOfPublishedCapabilities:', aux, false, this.nextMessageId++));
    // Only start consuming inbound frames after the handshake is on the wire, so
    // the checkin reader above is the sole consumer until this point.
    void this.readLoop();
  }

  /**
   * Invokes a daemon selector and resolves with its decoded return value.
   *
   * @param selector The Objective-C selector, e.g. `deviceCapabilities`.
   * @param aux Encoded arguments, or `null` for a no-argument selector.
   * @param options Reply timeout.
   */
  invoke(selector: string, aux: MessageAux | null = null, options: InvokeOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('Connection closed'));
    }
    const identifier = this.nextMessageId++;
    const {timeoutMs = 15000} = options;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(identifier);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for reply to ${selector}`));
      }, timeoutMs);
      this.pendingReplies.set(identifier, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write(this.buildFrame(selector, aux, true, identifier));
      } catch (error) {
        clearTimeout(timer);
        this.pendingReplies.delete(identifier);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a selector without waiting for a reply. */
  invokeOneway(selector: string, aux: MessageAux | null = null): void {
    this.write(this.buildFrame(selector, aux, false, this.nextMessageId++));
  }

  /** Closes the connection. */
  close(): void {
    this.onClose(new Error('Accessibility audit connection closed by caller'));
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Decodes a DTX `DTXPrimitiveArray` back into its values — the inverse of
 * {@link buildAuxiliaryData}. Handles the three types this protocol uses:
 * archived objects, 32-bit and 64-bit integers.
 */
function parseAuxiliary(buffer: Buffer): unknown[] {
  if (buffer.length < 16) {
    return [];
  }
  // The leading word is NOT a fixed constant. `DTX_CONSTANTS.MESSAGE_AUX_MAGIC`
  // (0x1f0) is only the value this codebase writes; the device also sends 0x3f0
  // and 0x7f0 — observed live, larger values on larger payloads, so it encodes a
  // capacity rather than identifying the format. Requiring an exact match
  // silently discarded every audit issue. The declared item length is validated
  // instead, and the item loop bails on anything it does not recognise.
  const itemsLength = Number(buffer.readBigUInt64LE(8));
  if (itemsLength <= 0 || itemsLength > buffer.length) {
    return [];
  }
  const end = Math.min(16 + itemsLength, buffer.length);
  const values: unknown[] = [];
  let offset = 16;
  while (offset + 8 <= end) {
    // Each item is prefixed by an empty-dictionary marker then a type word.
    if (buffer.readUInt32LE(offset) === DTX_CONSTANTS.EMPTY_DICTIONARY) {
      offset += 4;
    }
    const type = buffer.readUInt32LE(offset);
    offset += 4;
    if (type === DTX_CONSTANTS.AUX_TYPE_OBJECT) {
      const length = buffer.readUInt32LE(offset);
      offset += 4;
      const objectData = buffer.subarray(offset, offset + length);
      offset += length;
      values.push(decodeNSKeyedArchiver(parseBinaryPlist(objectData)));
    } else if (type === DTX_CONSTANTS.AUX_TYPE_INT32) {
      values.push(buffer.readInt32LE(offset));
      offset += 4;
    } else if (type === DTX_CONSTANTS.AUX_TYPE_INT64) {
      values.push(Number(buffer.readBigInt64LE(offset)));
      offset += 8;
    } else {
      // Unknown type — stop rather than misread the rest of the array.
      break;
    }
  }
  return values;
}

/**
 * Encodes a {@link MessageAux} as a DTX `DTXPrimitiveArray`, byte-identical to
 * {@link DVTSecureSocketProxyService}'s private encoder.
 */
function buildAuxiliaryData(aux: MessageAux): Buffer {
  const values = aux.getValues();
  if (values.length === 0) {
    return Buffer.alloc(0);
  }
  const parts: Buffer[] = [];
  for (const {type, value} of values) {
    const marker = Buffer.alloc(8);
    marker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
    marker.writeUInt32LE(type, 4);
    parts.push(marker);
    if (type === DTX_CONSTANTS.AUX_TYPE_OBJECT) {
      // An AxPoint has to be archived as an NSValue, which the generic encoder
      // cannot express — see `ax-values.ts`.
      const archive = value instanceof AxPoint ? archiveAxPoint(value) : new NSKeyedArchiverEncoder().encode(value);
      const encoded = createBinaryPlist(archive);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(encoded.length, 0);
      parts.push(length, encoded);
    } else if (type === DTX_CONSTANTS.AUX_TYPE_INT32) {
      const encoded = Buffer.alloc(4);
      encoded.writeUInt32LE(value as number, 0);
      parts.push(encoded);
    } else {
      const encoded = Buffer.alloc(8);
      encoded.writeBigUInt64LE(BigInt(value as number | bigint), 0);
      parts.push(encoded);
    }
  }
  const itemsData = Buffer.concat(parts);
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
  header.writeBigUInt64LE(BigInt(itemsData.length), 8);
  return Buffer.concat([header, itemsData]);
}
