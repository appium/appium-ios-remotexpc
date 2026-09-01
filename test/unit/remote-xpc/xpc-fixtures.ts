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
