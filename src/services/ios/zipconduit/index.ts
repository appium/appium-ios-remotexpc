import fsp from 'node:fs/promises';
import type net from 'node:net';

import { getLogger } from '../../../lib/logger.js';
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

/**
 * Streaming zip_conduit client for fast IPA installation over RSD.
 */
export class ZipConduitService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.streaming_zip_conduit.shim.remote';

  private socket: net.Socket | null = null;

  constructor(private readonly address: [string, number]) {}

  /**
   * Connect to the zip_conduit service and complete the RSD handshake.
   */
  async connect(): Promise<void> {
    if (this.socket) {
      return;
    }
    this.socket = await createRawServiceSocket(
      this.address[0],
      this.address[1],
    );
  }

  /**
   * Install an IPA or app directory using streaming zip_conduit.
   */
  async install(
    appPath: string,
    options: {
      progress?: ZipConduitProgressCallback;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    await this.connect();
    const socket = this.socket;
    if (!socket) {
      throw new Error('ZipConduitService is not connected');
    }

    const stats = await fsp.stat(appPath);
    if (stats.isDirectory()) {
      throw new Error(
        'Directory install is not supported yet; provide a path to an .ipa file',
      );
    }

    await this.sendIpaFile(socket, appPath, options);
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
    options: {
      progress?: ZipConduitProgressCallback;
      timeoutMs?: number;
    },
  ): Promise<void> {
    const init = createInitTransfer(ipaPath);
    await withZipFile(ipaPath, async (zip) => {
      const entries = await listZipEntries(zip);
      const { totalBytes, numFiles } = collectZipStats(entries);
      log.debug(`Sending InitTransfer for ${init.MediaSubdir}`);
      await sendOnePlist(socket, init as unknown as PlistDictionary);

      await transferMetaInfDirectory(socket);
      await transferMetaInfFile(socket, numFiles, totalBytes);

      const streamStart = performance.now();
      for (const entry of entries) {
        if (isDirectoryEntry(entry)) {
          await transferDirectory(socket, entry.name);
          continue;
        }

        const stream = await openZipEntryStream(zip, entry);
        try {
          await transferFile(socket, stream, entry.crc, entry.size, entry.name);
        } finally {
          stream.destroy();
        }
      }

      log.debug('IPA payload sent, writing central directory marker');
      await writeBufferToSocket(socket, CENTRAL_DIRECTORY_HEADER);
      log.info(
        `zip_conduit stream finished in ${formatSeconds(performance.now() - streamStart)}`,
      );
    });
    await this.waitForInstallation(socket, options);
  }

  private async waitForInstallation(
    socket: net.Socket,
    options: {
      progress?: ZipConduitProgressCallback;
      timeoutMs?: number;
    },
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
