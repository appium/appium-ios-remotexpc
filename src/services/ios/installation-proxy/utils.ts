import { getLogger } from '../../../lib/logger.js';
import type { InstallAction, InstallOperationResult } from './types.js';

const log = getLogger('InstallationProxyService');

/**
 * Constants for install/upgrade operation messages
 */
export const INSTALL_MESSAGES = {
  FRESH_INSTALL: 'App was not previously installed',
  VERSION_UNKNOWN: 'Current version could not be determined',
  DOWNGRADE_NOT_SUPPORTED:
    'Downgrades are not supported by iOS installation_proxy',
  SAME_VERSION_NOT_SUPPORTED:
    'Reinstalling the same version is not supported by iOS installation_proxy',
} as const;

/**
 * Compare two version strings
 * @param version1 First version string (e.g., '1.2.3')
 * @param version2 Second version string (e.g., '1.2.4')
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
  // Handle build numbers like "1.2.3 (123)" by extracting just the version part
  const cleanVersion1 = version1.split(/[\s(]/)[0];
  const cleanVersion2 = version2.split(/[\s(]/)[0];

  const parts1 = cleanVersion1.split('.').map((p) => parseInt(p, 10) || 0);
  const parts2 = cleanVersion2.split('.').map((p) => parseInt(p, 10) || 0);

  // Pad arrays to same length
  const maxLength = Math.max(parts1.length, parts2.length);
  while (parts1.length < maxLength) {
    parts1.push(0);
  }
  while (parts2.length < maxLength) {
    parts2.push(0);
  }

  // Compare each part
  for (let i = 0; i < maxLength; i++) {
    if (parts1[i] < parts2[i]) {
      return -1;
    }
    if (parts1[i] > parts2[i]) {
      return 1;
    }
  }

  return 0; // Versions are equal
}

/**
 * Create standardized result object
 */
export function createResult(
  action: InstallAction,
  reason: string,
  targetVersion: string,
  currentVersion?: string,
): InstallOperationResult {
  return {
    action,
    reason,
    targetVersion,
    ...(currentVersion && { currentVersion }),
  };
}

/**
 * Check if installation should proceed based on version comparison
 * @returns Result object with action and reason
 */
export function shouldInstall(
  isInstalled: boolean,
  targetVersion: string,
): InstallOperationResult | null {
  if (!isInstalled) {
    log.debug('App is not installed. Install will proceed.');
    return null; // Proceed with install
  }

  log.debug('App is already installed. Skipping install.');
  return createResult(
    'skipped',
    'App is already installed. Use upgrade to update.',
    targetVersion,
  );
}

/**
 * Check if upgrade should proceed based on version comparison
 * @returns Result object with action and reason, or null to proceed
 */
export function shouldUpgrade(
  isInstalled: boolean,
  currentVersion: string | undefined,
  targetVersion: string,
): InstallOperationResult | null {
  if (!isInstalled) {
    log.warn('App is not installed. Cannot upgrade.');
    return createResult(
      'skipped',
      'App is not installed. Use install instead.',
      targetVersion,
    );
  }

  if (!currentVersion) {
    log.warn(
      'Could not determine current version. Proceeding with upgrade anyway.',
    );
    return null; // Proceed with upgrade
  }

  log.debug(
    `Current version: ${currentVersion}, Target version: ${targetVersion}`,
  );

  const comparison = compareVersions(currentVersion, targetVersion);

  if (comparison < 0) {
    log.debug(
      `Current version ${currentVersion} is older than ${targetVersion}. Upgrading.`,
    );
    return null; // Proceed with upgrade
  }

  if (comparison > 0) {
    log.warn(
      `Current version ${currentVersion} is newer than target ${targetVersion}. Downgrades are not supported by iOS.`,
    );
    return createResult(
      'skipped',
      `Current version ${currentVersion} is newer than target ${targetVersion}. ${INSTALL_MESSAGES.DOWNGRADE_NOT_SUPPORTED}`,
      targetVersion,
      currentVersion,
    );
  }

  log.debug(`App is already at version ${targetVersion}. Skipping reinstall.`);
  return createResult(
    'skipped',
    `App is already at version ${targetVersion}. ${INSTALL_MESSAGES.SAME_VERSION_NOT_SUPPORTED}`,
    targetVersion,
    currentVersion,
  );
}
