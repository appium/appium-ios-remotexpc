import { expect } from 'chai';

import {
  type TunnelRegistryServer,
  startTunnelRegistryServer,
} from '../../../src/lib/tunnel/tunnel-registry-server.js';
import type {
  TunnelRegistry,
  TunnelRegistryEntry,
} from '../../../src/lib/types.js';

describe('TunnelRegistryServer', function () {
  let server: TunnelRegistryServer;
  const testPort = 4724;

  // Test data
  const testRegistry = {
    tunnels: {
      'test-udid-123': {
        udid: 'test-udid-123',
        deviceId: 1,
        address: '127.0.0.1',
        rsdPort: 58783,
        services: {
          'com.apple.afc.shim.remote': { port: '49374' },
        },
        catalogUpdatedAt: Date.now(),
        connectionType: 'USB',
        productId: 12345,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
      },
    },
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalTunnels: 1,
      activeTunnels: 1,
    },
  };

  beforeEach(async function () {
    server = await startTunnelRegistryServer(testRegistry, testPort);
  });

  afterEach(async function () {
    if (server) {
      await server.stop();
    }
  });

  describe('GET /remotexpc/tunnels', function () {
    it('should return all tunnels', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels`,
      );
      const data = (await response.json()) as TunnelRegistry;

      expect(response.status).to.equal(200);
      expect(data).to.have.property('tunnels');
      expect(data).to.have.property('metadata');
      expect(data.tunnels).to.have.property('test-udid-123');
    });
  });

  describe('GET /remotexpc/tunnels/metadata', function () {
    it('should return registry metadata', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/metadata`,
      );
      const data = (await response.json()) as TunnelRegistry['metadata'] & {
        status: string;
      };

      expect(response.status).to.equal(200);
      expect(data).to.have.property('totalTunnels');
      expect(data).to.have.property('activeTunnels');
      expect(data).to.have.property('lastUpdated');
      expect(data.totalTunnels).to.equal(1);
      expect(data.activeTunnels).to.equal(1);
    });
  });

  describe('GET /remotexpc/tunnels/:udid', function () {
    it('should return tunnel by UDID', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/test-udid-123`,
      );
      const data = (await response.json()) as TunnelRegistryEntry;

      expect(response.status).to.equal(200);
      expect(data.udid).to.equal('test-udid-123');
      expect(data.deviceId).to.equal(1);
    });

    it('should return 404 for non-existent UDID', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/non-existent`,
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(404);
      expect(data).to.have.property('error');
      expect(data.error).to.include('Tunnel not found');
    });

    it('should return 404 for a pending tunnel when waitMs=0', async function () {
      const pendingPort = testPort + 1;
      const pendingRegistry = {
        tunnels: {
          'pending-udid': {
            udid: 'pending-udid',
            deviceId: 2,
            address: '127.0.0.2',
            rsdPort: 1,
            services: {},
            connectionType: 'USB',
            productId: 0,
            createdAt: Date.now(),
            lastUpdated: Date.now(),
          },
        },
        metadata: testRegistry.metadata,
      };
      const pendingServer = await startTunnelRegistryServer(
        pendingRegistry,
        pendingPort,
      );

      try {
        const response = await fetch(
          `http://localhost:${pendingPort}/remotexpc/tunnels/pending-udid?waitMs=0`,
        );
        const data = (await response.json()) as { error: string };

        expect(response.status).to.equal(404);
        expect(data.error).to.include('Tunnel not found');
      } finally {
        await pendingServer.stop();
      }
    });
  });

  describe('POST /remotexpc/tunnels/:udid/refresh-services', function () {
    it('should refresh and return the updated catalog', async function () {
      const refreshPort = testPort + 2;
      const refreshRegistry = {
        tunnels: {
          'refresh-udid': {
            ...testRegistry.tunnels['test-udid-123'],
            udid: 'refresh-udid',
          },
        },
        metadata: testRegistry.metadata,
      };

      const refreshServices = async (
        udid: string,
        entry: TunnelRegistryEntry,
      ) => ({
        ...entry,
        services: {
          'com.apple.dvt.shim.remote': { port: '62078' },
        },
        catalogUpdatedAt: Date.now(),
      });

      const refreshServer = await startTunnelRegistryServer(
        refreshRegistry,
        refreshPort,
        { refreshServices },
      );

      try {
        const response = await fetch(
          `http://localhost:${refreshPort}/remotexpc/tunnels/refresh-udid/refresh-services`,
          { method: 'POST' },
        );
        const data = (await response.json()) as TunnelRegistryEntry;

        expect(response.status).to.equal(200);
        expect(data.services['com.apple.dvt.shim.remote']?.port).to.equal(
          '62078',
        );
      } finally {
        await refreshServer.stop();
      }
    });
  });

  describe('GET /remotexpc/tunnels/device/:deviceId', function () {
    it('should return tunnel by device ID', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/device/1`,
      );
      const data = (await response.json()) as TunnelRegistryEntry;

      expect(response.status).to.equal(200);
      expect(data.udid).to.equal('test-udid-123');
      expect(data.deviceId).to.equal(1);
    });

    it('should return 404 for non-existent device ID', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/device/999`,
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(404);
      expect(data).to.have.property('error');
      expect(data.error).to.include('Tunnel not found');
    });

    it('should return 400 for invalid device ID', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/device/invalid`,
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(400);
      expect(data).to.have.property('error');
      expect(data.error).to.equal('Invalid device ID');
    });
  });

  describe('PUT /remotexpc/tunnels/:udid', function () {
    it('should update tunnel', async function () {
      const updateData = {
        ...testRegistry.tunnels['test-udid-123'],
        rsdPort: 58784,
      };

      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/test-udid-123`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData),
        },
      );
      const data = (await response.json()) as {
        success: boolean;
        tunnel: TunnelRegistryEntry;
      };

      expect(response.status).to.equal(200);
      expect(data).to.have.property('success', true);
      expect(data.tunnel.rsdPort).to.equal(58784);
    });

    it('should return 400 for UDID mismatch', async function () {
      const updateData = {
        ...testRegistry.tunnels['test-udid-123'],
        udid: 'different-udid',
      };

      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/test-udid-123`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData),
        },
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(400);
      expect(data).to.have.property('error');
      expect(data.error).to.include('UDID mismatch');
    });

    it('should return 400 for invalid JSON', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/remotexpc/tunnels/test-udid-123`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        },
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(400);
      expect(data).to.have.property('error');
    });
  });

  describe('Unknown routes', function () {
    it('should return 404 for unknown routes', async function () {
      const response = await fetch(
        `http://localhost:${testPort}/unknown/route`,
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).to.equal(404);
      expect(data).to.have.property('error', 'Not found');
    });
  });
});
