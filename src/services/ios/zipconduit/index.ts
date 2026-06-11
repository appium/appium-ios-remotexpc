import fsp from 'node:fs/promises';
import type net from 'node:net';

import { getLogger } from '../../../lib/logger.js';
import {
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  resolveTunnelService,
} from '../../../lib/tunnel/tunnel-service-resolver.js';
import type { PlistDictionary } from '../../../lib/types.js';
import {
  cleanupServiceSocket,
  createRawServiceSocket,
  recvOnePlist,
  sendOnePlist,
  writeBufferToSocket,
} from '../afc/codec.js';
import {
  CENTRAL_DIRECTORY_HEADER,
  DEFAULT_INSTALL_TIMEOUT_MS,
} from './constants.js';
import {
  type ZipConduitProgressUpdate,
  createInitTransfer,
  evaluateProgress,
} from './plists.js';
import {
  type IpaZipEntry,
  listZipEntries,
  openZipEntryStream,
  withZipFile,
} from './zip-reader.js';
import {
  transferDirectory,
  transferFile,
  transferMetaInfDirectory,
  transferMetaInfFile,
} from './zip-utils.js';

const log = getLogger('ZipConduitService');

export type ZipConduitProgressCallback = (
  update: ZipConduitProgressUpdate,
) => void;

export interface ZipConduitInstallOptions {
  progress?: ZipConduitProgressCallback;
  timeoutMs?: number;
  /** Stop after payload upload; skip waiting for install progress plists. */
  streamOnly?: boolean;
}

export interface ZipConduitStreamStats {
  streamMs: number;
  payloadBytes: number;
  entryCount: number;
}

/**
 * Streaming zip_conduit client for fast IPA installation over RSD.
 */
export class ZipConduitService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.streaming_zip_conduit.shim.remote';

  private socket: net.Socket | null = null;

  constructor(private readonly udid: string) {}

  /**
   * Connect to the zip_conduit service and complete the RSD handshake.
   */
  async connect(): Promise<void> {
    if (this.socket) {
      return;
    }
    const { host, port } = await resolveTunnelService(
      this.udid,
      ZipConduitService.RSD_SERVICE_NAME,
      { waitMs: DEFAULT_TUNNEL_SERVICE_WAIT_MS },
    );
    this.socket = await createRawServiceSocket(host, port);
  }

  /**
   * Install an IPA or app directory using streaming zip_conduit.
   */
  async install(
    appPath: string,
    options: ZipConduitInstallOptions = {},
  ): Promise<ZipConduitStreamStats | void> {
    await this.connect();
    const socket = this.socket;
    if (!socket) {
      throw new Error('ZipConduitService is not connected');
    }

    const fileStats = await fsp.stat(appPath);
    if (fileStats.isDirectory()) {
      throw new Error(
        'Directory install is not supported yet; provide a path to an .ipa file',
      );
    }

    const streamStats = await this.sendIpaFile(socket, appPath);
    if (options.streamOnly) {
      return streamStats;
    }
    await this.waitForInstallation(socket, options);
  }

  /**
   * Close the underlying socket.
   */
  close(): void {
    if (!this.socket) {
      return;
    }
    cleanupServiceSocket(this.socket);
    this.socket = null;
  }

  private async sendIpaFile(
    socket: net.Socket,
    ipaPath: string,
  ): Promise<ZipConduitStreamStats> {
    const streamStart = performance.now();
    let payloadBytes = 0;

    const init = createInitTransfer(ipaPath);
    const { entries } = await withZipFile(ipaPath, async (zip) => {
      const listed = await listZipEntries(zip);
      const { totalBytes, numFiles } = collectZipStats(listed);
      log.debug(`Sending InitTransfer for ${init.MediaSubdir}`);
      await sendOnePlist(socket, init as unknown as PlistDictionary);

      await transferMetaInfDirectory(socket);
      await transferMetaInfFile(socket, numFiles, totalBytes);

      for (const entry of listed) {
        if (isDirectoryEntry(entry)) {
          await transferDirectory(socket, entry.name);
          continue;
        }

        const stream = await openZipEntryStream(zip, entry);
        try {
          await transferFile(socket, stream, entry.crc, entry.size, entry.name);
          payloadBytes += entry.size;
        } finally {
          stream.destroy();
        }
      }

      return { entries: listed };
    });

    log.debug('IPA payload sent, writing central directory marker');
    await writeBufferToSocket(socket, CENTRAL_DIRECTORY_HEADER);

    const streamMs = performance.now() - streamStart;
    const stats: ZipConduitStreamStats = {
      streamMs,
      payloadBytes,
      entryCount: entries.length,
    };
    log.debug(
      `zip_conduit stream finished in ${formatSeconds(streamMs)} ` +
        `(${formatMiBPerSec(payloadBytes, streamMs)}, ${entries.length} entries)`,
    );
    return stats;
  }

  private async waitForInstallation(
    socket: net.Socket,
    options: Pick<ZipConduitInstallOptions, 'progress' | 'timeoutMs'>,
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const startTime = performance.now();

    while (performance.now() - startTime <= timeoutMs) {
      const remaining = timeoutMs - (performance.now() - startTime);
      const plist = await recvOnePlistWithTimeout(socket, remaining);
      const { done, percent, status } = evaluateProgress(plist);
      options.progress?.({ percent, status });
      if (done) {
        return;
      }
    }

    throw new Error(
      `Timed out waiting for zip_conduit installation after ${timeoutMs}ms`,
    );
  }
}

function collectZipStats(entries: IpaZipEntry[]): {
  totalBytes: number;
  numFiles: number;
} {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return { totalBytes, numFiles: entries.length };
}

function isDirectoryEntry(entry: IpaZipEntry): boolean {
  return entry.isDirectory || entry.name.endsWith('/');
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMiBPerSec(bytes: number, ms: number): string {
  if (ms <= 0) {
    return 'n/a';
  }
  const mibPerSec = bytes / (1024 * 1024) / (ms / 1000);
  return `${mibPerSec.toFixed(2)} MiB/s`;
}

async function recvOnePlistWithTimeout(
  socket: net.Socket,
  timeoutMs: number,
): Promise<PlistDictionary> {
  if (timeoutMs <= 0) {
    throw new Error('Timed out waiting for zip_conduit progress update');
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for zip_conduit progress after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([recvOnePlist(socket), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export default ZipConduitService;
