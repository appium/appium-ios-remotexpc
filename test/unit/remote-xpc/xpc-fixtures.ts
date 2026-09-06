import assert from 'node:assert/strict';

import {DataFrame} from '../../../src/lib/remote-xpc/handshake-frames.js';
import {encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';

const STRING_TYPE_TAG = 0x00009000;
const FILE_TRANSFER_TYPE_TAG = 0x0001a000;

export function buildMessage(body: XPCDictionary, id = 1): Buffer {
  return encodeMessage({flags: 0x00000001, id: BigInt(id), body});
}

/** Retags the encoded string value as the unimplemented fileTransfer type, keeping framing intact. */
export function withUnsupportedValueType(payload: Buffer): Buffer {
  const retagged = Buffer.from(payload);
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(STRING_TYPE_TAG);
  const offset = retagged.indexOf(tag);
  assert.ok(offset > 0, 'expected an encoded string type tag to retag');
  retagged.writeUInt32LE(FILE_TRANSFER_TYPE_TAG, offset);
  return retagged;
}

/** A framed message the decoder cannot read: correct wrapper, unsupported value type. */
export function buildUndecodableMessage(id = 1): Buffer {
  return withUnsupportedValueType(buildMessage({payload: 'unsupported'}, id));
}

export function buildCatalogMessage(serviceName = 'com.apple.afc.shim.remote', port = '52280'): Buffer {
  return buildMessage({MessageType: 'Handshake', Services: {[serviceName]: {Port: port}}});
}

export function toDataFrame(payload: Buffer, streamId = 1): Buffer {
  return new DataFrame(streamId, payload, []).serialize();
}

const FRAME_TYPE_RST_STREAM = 0x03;
const FRAME_TYPE_PING = 0x06;
const FRAME_TYPE_GOAWAY = 0x07;

function toRawFrame(type: number, streamId: number, body: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header.writeUIntBE(body.length, 0, 3);
  header.writeUInt8(type, 3);
  header.writeUInt32BE(streamId, 5);
  return Buffer.concat([header, body]);
}

/** RST_STREAM (RFC 7540 §6.4); error code 5 (STREAM_CLOSED) is what `remoted` contention produces. */
export function toRstStreamFrame(streamId: number, errorCode = 5): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(errorCode);
  return toRawFrame(FRAME_TYPE_RST_STREAM, streamId, body);
}

/** GOAWAY (RFC 7540 §6.8) on stream 0. */
export function toGoAwayFrame(lastStreamId: number, errorCode = 1): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32BE(lastStreamId);
  body.writeUInt32BE(errorCode, 4);
  return toRawFrame(FRAME_TYPE_GOAWAY, 0, body);
}

/** PING (RFC 7540 §6.7): a non-DATA frame the transport must keep tolerating. */
export function toPingFrame(): Buffer {
  return toRawFrame(FRAME_TYPE_PING, 0, Buffer.alloc(8));
}
