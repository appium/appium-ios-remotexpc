import path from 'node:path';

import type {PlistDictionary} from '../../../lib/types.js';
import {STD_DIR_PERM, STD_FILE_PERM} from './constants.js';

export const SIGNING_ERROR = 'ApplicationVerificationFailed';

export interface ZipConduitMetadata {
  StandardDirectoryPerms: number;
  StandardFilePerms: number;
  RecordCount: number;
  TotalUncompressedBytes: number;
  Version: number;
}

export interface InitTransferRequest {
  InstallOptionsDictionary: {
    DisableDeltaTransfer: number;
    InstallDeltaTypeKey: string;
    IsUserInitiated: number;
    PackageType: string;
    PreferWifi: number;
  };
  InstallTransferredDirectory: number;
  MediaSubdir: string;
  UserInitiatedTransfer: number;
}

export interface ZipConduitProgressUpdate {
  percent: number;
  status: string;
}

/**
 * Build the InitTransfer plist payload for zip_conduit.
 * @param fileName Local IPA path used to derive the PublicStaging destination.
 */
export function createInitTransfer(fileName: string): InitTransferRequest {
  const base = path.basename(fileName);
  return {
    InstallTransferredDirectory: 1,
    UserInitiatedTransfer: 0,
    MediaSubdir: `PublicStaging/${base}`,
    InstallOptionsDictionary: {
      InstallDeltaTypeKey: 'InstallDeltaTypeSparseIPAFiles',
      DisableDeltaTransfer: 1,
      IsUserInitiated: 1,
      PreferWifi: 1,
      PackageType: 'Customer',
    },
  };
}

/**
 * Build ZipMetadata plist values embedded in the streamed archive.
 * @param numFiles Number of entries in the source IPA.
 * @param totalBytes Sum of uncompressed sizes for all IPA entries.
 */
export function createMetaInfPlist(numFiles: number, totalBytes: number): ZipConduitMetadata {
  return {
    RecordCount: 2 + numFiles,
    StandardDirectoryPerms: STD_DIR_PERM,
    StandardFilePerms: STD_FILE_PERM,
    TotalUncompressedBytes: totalBytes,
    Version: 2,
  };
}

/**
 * Parse a zip_conduit progress plist into completion state and percentage.
 * @param progressUpdate Progress plist received from the device.
 */
export function evaluateProgress(progressUpdate: PlistDictionary): {
  done: boolean;
  percent: number;
  status: string;
} {
  const topStatus = asString(progressUpdate.Status);
  if (topStatus === 'DataComplete') {
    return {done: true, percent: 100, status: topStatus};
  }

  // The device can report a failure as a top-level Error (e.g. ExtractionFailed)
  // with no InstallProgressDict; surface the real reason instead of a generic
  // "missing InstallProgressDict".
  const topError = asString(progressUpdate.Error);
  if (topError) {
    const topDescription = asString(progressUpdate.ErrorDescription) ?? '';
    throw new Error(`Failed installing: '${topError}'${topDescription ? ` errorDescription:'${topDescription}'` : ''}`);
  }

  const installProgressDict = progressUpdate.InstallProgressDict;
  if (!installProgressDict || typeof installProgressDict !== 'object') {
    throw new Error(`Invalid progress update, missing InstallProgressDict: ${JSON.stringify(progressUpdate)}`);
  }

  const progress = installProgressDict as PlistDictionary;
  const errorMessage = asString(progress.Error);
  if (errorMessage) {
    const description = asString(progress.ErrorDescription) ?? '';
    if (errorMessage === SIGNING_ERROR) {
      throw new Error(
        `App is not properly signed for this device. original error: '${errorMessage}' errorDescription:'${description}'`,
      );
    }
    throw new Error(`Failed installing: '${errorMessage}' errorDescription:'${description}'`);
  }

  const percent = asNumber(progress.PercentComplete) ?? 0;
  const status = asString(progress.Status) ?? '';
  return {done: false, percent, status};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
