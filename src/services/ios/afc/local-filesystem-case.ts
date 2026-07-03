import {execFile} from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {plist} from '@appium/support';

import {getLogger} from '../../../lib/logger.js';

const log = getLogger('LocalFilesystemCase');

const execFileAsync = promisify(execFile);

const caseSensitivityByDevice = new Map<string, boolean>();

/** Subset of keys returned by `diskutil info -plist`. */
export interface DiskutilInfoPlist {
  FilesystemName?: string;
  FilesystemUserVisibleName?: string;
  VolumeName?: string;
  [key: string]: unknown;
}

/**
 * Whether distinct path segments that differ only by letter case collide on `dir`.
 *
 * On macOS, uses `diskutil info -plist` for the volume backing `dir`. Results are
 * cached per device identifier.
 */
export async function isCaseSensitiveDirectory(dir: string): Promise<boolean> {
  const resolved = await fsp.realpath(dir).catch(() => path.resolve(dir));

  let caseSensitive: boolean;
  switch (os.platform()) {
    case 'win32':
      caseSensitive = false;
      break;
    case 'linux':
      caseSensitive = true;
      break;
    case 'darwin':
      try {
        caseSensitive = await getDarwinCaseSensitivity(resolved);
      } catch (err) {
        log.info(`Could not determine case sensitivity for '${resolved}'; assuming case-insensitive:`, err);
        caseSensitive = false;
      }
      break;
    default:
      caseSensitive = true;
  }

  return caseSensitive;
}

/**
 * Derive case sensitivity from a parsed `diskutil info -plist` object.
 *
 * Case-sensitive APFS reports `FilesystemName: Case-sensitive APFS` and/or
 * `FilesystemUserVisibleName: APFS (Case-sensitive)`. Default APFS/HFS+ installs are
 * case-insensitive when not labeled otherwise.
 */
export function parseDiskutilInfoPlist(info: DiskutilInfoPlist): boolean {
  const explicit = getExplicitCaseSensitiveField(info);
  if (explicit !== undefined) {
    return explicit;
  }

  const filesystemName = stringField(info.FilesystemName);
  const visibleName = stringField(info.FilesystemUserVisibleName);

  for (const value of [filesystemName, visibleName]) {
    if (!value) {
      continue;
    }
    if (/case-insensitive/i.test(value)) {
      return false;
    }
    if (/case-sensitive/i.test(value)) {
      return true;
    }
  }

  if (filesystemName?.includes('HFS') && !/case-sensitive/i.test(filesystemName)) {
    return false;
  }

  if (filesystemName === 'APFS' || visibleName === 'APFS') {
    return false;
  }

  throw new Error('diskutil info plist did not include recognizable case-sensitivity details');
}

/** @internal Reset cached probe results (unit tests only). */
export function clearCaseSensitivityCache(): void {
  caseSensitivityByDevice.clear();
}

async function getDarwinCaseSensitivity(dir: string): Promise<boolean> {
  const device = await getDeviceIdentifierForPath(dir);
  const cached = caseSensitivityByDevice.get(device);
  if (cached !== undefined) {
    return cached;
  }

  const {stdout} = await execFileAsync('diskutil', ['info', '-plist', device], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });

  const diskInfo = plist.parsePlist(stdout) as DiskutilInfoPlist;
  const caseSensitive = parseDiskutilInfoPlist(diskInfo);
  caseSensitivityByDevice.set(device, caseSensitive);
  return caseSensitive;
}

async function getDeviceIdentifierForPath(dir: string): Promise<string> {
  const {stdout} = await execFileAsync('df', ['-P', dir], {
    encoding: 'utf8',
  });
  const lines = stdout.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  if (!dataLine) {
    throw new Error(`df produced no output for '${dir}'`);
  }

  const devicePath = dataLine.split(/\s+/)[0];
  if (!devicePath?.startsWith('/dev/')) {
    throw new Error(`Unexpected df device for '${dir}': ${devicePath ?? ''}`);
  }

  return devicePath.slice('/dev/'.length);
}

function getExplicitCaseSensitiveField(info: DiskutilInfoPlist): boolean | undefined {
  for (const [key, value] of Object.entries(info)) {
    if (!/case-sensitive/i.test(key)) {
      continue;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (normalized === 'yes' || normalized === 'true') {
        return true;
      }
      if (normalized === 'no' || normalized === 'false') {
        return false;
      }
    }
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
