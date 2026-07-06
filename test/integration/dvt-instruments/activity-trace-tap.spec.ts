import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

import type {ActivityTraceMessage, DVTInstruments} from '../../../src/index.js';
import {ActivityTraceTap} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {DVTSecureSocketProxyService} from '../../../src/services/ios/dvt/index.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('ActivityTraceTap.test');
log.level = 'debug';

const KNOWN_MESSAGE_TYPES = new Set(['Default', 'Info', 'Debug', 'Error', 'Fault']);

async function withDVT(fn: (dvt: DVTInstruments) => Promise<void>): Promise<void> {
  const dvt = await Services.startDVTService(requireDeviceUdid());
  try {
    await fn(dvt);
  } finally {
    try {
      await dvt.dvtService.close();
    } catch {}
  }
}

describe('ActivityTraceTap', {timeout: 60000}, function () {
  describe('Message reception', function () {
    let dvt: DVTInstruments;
    const pool: ActivityTraceMessage[] = [];

    before(async function () {
      dvt = await Services.startDVTService(requireDeviceUdid());

      for await (const msg of dvt.activityTraceTap.messages()) {
        pool.push(msg);
        if (pool.length >= 10) {
          break;
        }
      }

      log.info(`pre-collected ${pool.length} messages for data-validation tests`);
    });

    after(async function () {
      try {
        await dvt.activityTraceTap.stop();
      } catch {}
      try {
        await dvt.dvtService.close();
      } catch {}
    });

    it('should yield at least one log entry', function () {
      expect(pool).to.have.length.greaterThan(0);
    });

    it('every entry should carry a "message" field as a string', function () {
      for (const msg of pool) {
        expect(msg, JSON.stringify(Object.keys(msg))).to.have.property('message');
        expect(msg.message, 'message field').to.be.a('string');
      }
    });

    it('should decode "process" as a positive integer on every entry', function () {
      for (const msg of pool) {
        expect(msg, JSON.stringify(Object.keys(msg))).to.have.property('process');
        expect(msg.process, 'process in entry').to.be.a('number').and.greaterThan(0);
      }
    });

    it('should decode "thread" as a positive integer on every entry', function () {
      for (const msg of pool) {
        expect(msg, JSON.stringify(Object.keys(msg))).to.have.property('thread');
        expect(msg.thread, 'thread in entry').to.be.a('number').and.greaterThan(0);
      }
    });

    it('should decode "subsystem" as a string on every entry', function () {
      for (const msg of pool) {
        expect(msg, JSON.stringify(Object.keys(msg))).to.have.property('subsystem');
        expect(msg.subsystem, 'subsystem field').to.be.a('string');
      }
    });

    it('should decode "category" as a string on every entry', function () {
      for (const msg of pool) {
        expect(msg, JSON.stringify(Object.keys(msg))).to.have.property('category');
        expect(msg.category, 'category field').to.be.a('string');
      }
    });

    it('should decode "message_type" as a known log level on os-log entries', function () {
      const withType = pool.filter((m) => 'message_type' in m && m.message_type != null);
      expect(withType, 'expected at least one entry with message_type').to.have.length.greaterThan(0);

      for (const msg of withType) {
        expect(KNOWN_MESSAGE_TYPES, `unexpected message_type value: ${JSON.stringify(msg.message_type)}`).to.include(
          msg.message_type,
        );
      }

      log.info('observed message_type values:', [...new Set(withType.map((m) => m.message_type))].join(', '));
    });

    it('entries from the same table definition should share the same column set', function () {
      if (pool.length < 2) {
        log.warn('pool too small to compare schemas; skipping');
        return;
      }

      const keysets = pool.map((m) => JSON.stringify(Object.keys(m).sort()));
      const unique = new Set(keysets);

      // The device advertises 4 tables (os-log, os-log-arg, os-signpost, os-signpost-arg)
      // so allow up to 4 distinct schemas.
      expect(unique.size).to.be.lessThan(5, `too many distinct column schemas: ${[...unique].join(' | ')}`);

      log.info(`${unique.size} distinct column schema(s) across ${pool.length} entries`);
    });
  });

  describe('Iteration lifecycle', function () {
    it('should start and stop without throwing', async function () {
      await withDVT(async (dvt) => {
        await dvt.activityTraceTap.start();
        await dvt.activityTraceTap.stop();
      });
    });

    it('should treat a second start() call as a no-op', async function () {
      await withDVT(async (dvt) => {
        await dvt.activityTraceTap.start();
        await dvt.activityTraceTap.start();

        for await (const msg of dvt.activityTraceTap.messages()) {
          expect(msg).to.be.an('object');
          break;
        }
      });
    });

    it('should terminate cleanly when the for-await loop breaks early', async function () {
      await withDVT(async (dvt) => {
        let count = 0;
        for await (const msg of dvt.activityTraceTap.messages()) {
          expect(msg).to.be.an('object');
          count++;
          if (count === 3) {
            break;
          }
        }
        expect(count).to.equal(3);
      });
    });

    it('should terminate cleanly when the generator is returned early', async function () {
      await withDVT(async (dvt) => {
        const gen = dvt.activityTraceTap.messages();
        const {value: first, done} = await gen.next();
        expect(done).to.not.equal(true);
        expect(first).to.be.an('object');
        await gen.return(undefined);
      });
    });

    it('should stop an active iterator when stop() is called', async function () {
      await withDVT(async (dvt) => {
        const tap = dvt.activityTraceTap;
        const iterator = tap.messages();

        const nextPromise = iterator.next();
        await new Promise((resolve) => setTimeout(resolve, 300));

        await tap.stop();

        const terminal = await Promise.race([
          (async () => {
            let result = await nextPromise;
            while (!result.done) {
              result = await iterator.next();
            }
            return result;
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('iterator did not stop after stop()')), 5000),
          ),
        ]);

        expect(terminal.done).to.equal(true);
      });
    });

    it('should end the stream without throwing when the DVT connection is closed', async function () {
      // Manages its own connection — withDVT would close it in finally, but
      // this test closes it mid-stream to verify the iterator exits cleanly.
      const dvt = await Services.startDVTService(requireDeviceUdid());
      const iterator = dvt.activityTraceTap.messages();

      const nextPromise = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 300));

      await dvt.dvtService.close();

      const terminal = await Promise.race([
        (async () => {
          let result = await nextPromise;
          while (!result.done) {
            result = await iterator.next();
          }
          return result;
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('iterator did not end after DVT close')), 5000),
        ),
      ]);

      expect(terminal.done).to.equal(true);
    });
  });

  describe('HTTP archive logging option', function () {
    it('should stream entries with enableHttpArchiveLogging:true', async function () {
      const dvtService = new DVTSecureSocketProxyService(requireDeviceUdid());
      await dvtService.connect();

      const tap = new ActivityTraceTap(dvtService, {enableHttpArchiveLogging: true});

      try {
        for await (const msg of tap.messages()) {
          expect(msg).to.be.an('object');
          expect(msg).to.have.property('message');
          break;
        }
      } finally {
        try {
          await tap.stop();
        } catch {}
        try {
          await dvtService.close();
        } catch {}
      }
    });
  });
});
