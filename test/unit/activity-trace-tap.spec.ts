import {describe, it} from 'node:test';

import {expect} from 'chai';

import type {DVTSecureSocketProxyService} from '../../src/services/ios/dvt/index.js';
import {ActivityTraceTap} from '../../src/services/ios/dvt/instruments/activity-trace-tap.js';

const dvtStub = {} as DVTSecureSocketProxyService;

function typeBuf(name: string): Buffer {
  return Buffer.from(`${name}\0`);
}

function le64(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}

function le32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return buf;
}

describe('ActivityTraceTap.parseEndRow', () => {
  // CMD_END_ROW word = (0x02 << 8) | tableId
  const endRow = (tableId = 0) => (0x02 << 8) | tableId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeTap(): any {
    return new ActivityTraceTap(dvtStub) as any;
  }

  it('returns null when table id is unknown', () => {
    const tap = makeTap();
    tap.stack = [];
    tap.tables = new Map();
    expect(tap.parseEndRow(endRow())).to.be.null;
  });

  it('returns null when stack has fewer items than columns', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 'test', columns: ['a', 'b']}]]);
    tap.stack = [Buffer.from('x')];
    expect(tap.parseEndRow(endRow())).to.be.null;
  });

  it('decodes time from LE uint64 buffer', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['time', 'name']}]]);
    tap.stack = [le64(1_000_000_000n), Buffer.from('x\0')];
    const msg = tap.parseEndRow(endRow());
    expect(msg).to.not.be.null;
    expect(msg.time).to.equal(1_000_000_000);
  });

  it('decodes process from struct (first element LE uint32)', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['process', 'name']}]]);
    tap.stack = [[le32(42)], Buffer.from('x\0')];
    expect(tap.parseEndRow(endRow()).process).to.equal(42);
  });

  it('sets process to 0 when stack item is null', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['process', 'name']}]]);
    tap.stack = [null, Buffer.from('x\0')];
    expect(tap.parseEndRow(endRow()).process).to.equal(0);
  });

  it('decodes thread from struct', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['thread', 'name']}]]);
    tap.stack = [[le32(7)], Buffer.from('x\0')];
    expect(tap.parseEndRow(endRow()).thread).to.equal(7);
  });

  it('decodes null-terminated string fields', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['subsystem', 'name']}]]);
    tap.stack = [Buffer.from('com.apple.test\0'), Buffer.from('x\0')];
    expect(tap.parseEndRow(endRow()).subsystem).to.equal('com.apple.test');
  });

  it('decodes message field as formatted string (string type)', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['message']}]]);
    tap.stack = [[[typeBuf('string'), Buffer.from('hello\0')]]];
    expect(tap.parseEndRow(endRow()).message).to.equal('hello');
  });

  it('decodes message field with private argument', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['message']}]]);
    tap.stack = [
      [
        [typeBuf('string'), Buffer.from('user=\0')],
        [typeBuf('private'), null],
      ],
    ];
    expect(tap.parseEndRow(endRow()).message).to.equal('user=<private>');
  });

  it('decodes message field with uint64 argument', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['message']}]]);
    tap.stack = [[[typeBuf('uint64'), le64(42)]]];
    expect(tap.parseEndRow(endRow()).message).to.equal('42');
  });

  it('synthesises message from format_string when message column is absent', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['format_string']}]]);
    tap.stack = [[[typeBuf('string'), Buffer.from('fmt\0')]]];
    expect(tap.parseEndRow(endRow()).message).to.equal('fmt');
  });

  it('uses name column as message for signpost rows', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['name']}]]);
    tap.stack = [Buffer.from('my-signpost\0')];
    expect(tap.parseEndRow(endRow()).message).to.equal('my-signpost');
  });

  it('drops rows with <5 columns and no message', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['a', 'b']}]]);
    tap.stack = [Buffer.from('x'), Buffer.from('y')];
    expect(tap.parseEndRow(endRow())).to.be.null;
  });

  it('synthesises message from longest buffer for rich tables (≥5 columns)', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['a', 'b', 'c', 'd', 'e']}]]);
    tap.stack = [Buffer.from('hi\0'), Buffer.from('longer text\0'), null, null, null];
    expect(tap.parseEndRow(endRow()).message).to.equal('longer text');
  });

  it('pops only the row columns leaving deeper stack items intact', () => {
    const tap = makeTap();
    tap.tables = new Map([[0, {name: 't', columns: ['name']}]]);
    tap.stack = [Buffer.from('extra1'), Buffer.from('extra2'), Buffer.from('signpost\0')];
    tap.parseEndRow(endRow());
    expect(tap.stack).to.have.lengthOf(2);
  });
});
