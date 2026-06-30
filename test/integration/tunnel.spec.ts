import { expect } from 'chai';
import { afterEach, before, describe, it } from 'node:test';

import type { SyslogService as ISyslogService } from '../../src/lib/types.js';
import {
  startSyslogBinaryService,
  startSyslogTextService,
} from '../../src/services.js';
import type { Service } from '../../src/services/ios/base-service.js';
import { requireDeviceUdid } from './helpers/device.js';

function registerCommonSyslogTests(
  getService: () => ISyslogService,
  getDescriptor: () => Service,
  getOptions: () => object,
) {
  it('should resolve service descriptor', function () {
    expect(getDescriptor()).to.not.be.undefined;
    expect(getDescriptor().port).to.be.a('string');
  });

  it('should start without error', async function () {
    await getService().start(getDescriptor(), getOptions());
  });

  it('should stop cleanly', async function () {
    const svc = getService();
    await svc.start(getDescriptor(), getOptions());
    await svc.stop();
  });
}

describe('Tunnel and Syslog Service', { timeout: 60000 }, function () {
  let udid: string;

  before(function () {
    udid = requireDeviceUdid();
  });

  describe('os_trace_relay binary-mode (os_trace_relay.shim.remote)', function () {
    let syslogService: ISyslogService;
    let serviceDescriptor: Service;

    before(async function () {
      ({ syslogService, serviceDescriptor } =
        await startSyslogBinaryService(udid));
    });

    afterEach(async function () {
      try {
        await syslogService.stop();
      } catch {}
    });

    registerCommonSyslogTests(
      () => syslogService,
      () => serviceDescriptor,
      () => ({ pid: -1 }),
    );

    it('should capture and emit syslog messages', async function () {
      const messages: string[] = [];
      syslogService.on('message', (message: string) => {
        messages.push(message);
      });
      await syslogService.start(serviceDescriptor, { pid: -1 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await syslogService.stop();
      expect(messages.length).to.be.greaterThan(0);
    });
  });

  describe('syslog_relay text-mode (syslog_relay.shim.remote)', function () {
    let syslogService: ISyslogService;
    let serviceDescriptor: Service;

    before(async function () {
      ({ syslogService, serviceDescriptor } =
        await startSyslogTextService(udid));
    });

    afterEach(async function () {
      try {
        await syslogService.stop();
      } catch {}
    });

    registerCommonSyslogTests(
      () => syslogService,
      () => serviceDescriptor,
      () => ({ pid: -1, textMode: true }),
    );
  });
});
