import {randomUUID} from 'node:crypto';
import path from 'node:path';

import {isCaseSensitiveDirectory} from './local-filesystem-case.js';
import {appendUniqueSuffix, sanitizeLocalFilename} from './sanitize-local-filename.js';

const MAX_ALLOCATION_ATTEMPTS = 100;

export type CaseSensitiveDirectoryCheck = (dir: string) => Promise<boolean>;

/**
 * Resolves sanitized local path segment names during a single AFC pull.
 * Adds a UUID-based suffix when the sanitized name is already taken in this pull, or
 * when `overwrite` is false and a file already exists at that path on disk.
 */
export class PullLocalNameAllocator {
  private readonly usedByDir = new Map<string, Set<string>>();
  private readonly caseSensitiveByDir = new Map<string, boolean>();

  constructor(
    private readonly pathExists: (localPath: string) => Promise<boolean>,
    private readonly overwrite: boolean,
    private readonly checkCaseSensitive: CaseSensitiveDirectoryCheck = isCaseSensitiveDirectory,
  ) {}

  async allocate(parentDir: string, remoteSegment: string): Promise<string> {
    const sanitized = sanitizeLocalFilename(remoteSegment);

    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? sanitized : appendUniqueSuffix(sanitized, randomSuffix());

      if (!(await this.hasClash(parentDir, candidate))) {
        this.register(parentDir, candidate);
        return candidate;
      }
    }

    throw new Error(`Could not allocate a unique local name for remote segment '${remoteSegment}'`);
  }

  private async hasClash(parentDir: string, name: string): Promise<boolean> {
    if (await this.isUsedInPull(parentDir, name)) {
      return true;
    }
    if (!this.overwrite) {
      return this.pathExists(path.join(parentDir, name));
    }
    return false;
  }

  private async isUsedInPull(parentDir: string, name: string): Promise<boolean> {
    const used = this.usedByDir.get(parentDir);
    if (!used) {
      return false;
    }
    for (const existing of used) {
      if (await this.namesCollide(parentDir, existing, name)) {
        return true;
      }
    }
    return false;
  }

  private async namesCollide(parentDir: string, a: string, b: string): Promise<boolean> {
    if (await this.isCaseSensitiveForDir(parentDir)) {
      return a === b;
    }
    return a.toLowerCase() === b.toLowerCase();
  }

  private async isCaseSensitiveForDir(parentDir: string): Promise<boolean> {
    let caseSensitive = this.caseSensitiveByDir.get(parentDir);
    if (caseSensitive === undefined) {
      caseSensitive = await this.checkCaseSensitive(parentDir);
      this.caseSensitiveByDir.set(parentDir, caseSensitive);
    }
    return caseSensitive;
  }

  private register(parentDir: string, name: string): void {
    let used = this.usedByDir.get(parentDir);
    if (!used) {
      used = new Set();
      this.usedByDir.set(parentDir, used);
    }
    used.add(name);
  }
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}
