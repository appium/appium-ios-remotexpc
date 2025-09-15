import { logger } from '@appium/support';
import axios from 'axios';
import { randomUUID } from 'node:crypto';

import { createPlist, parsePlist } from '../plist/index.js';
import type { PlistDictionary } from '../types.js';

const log = logger.getLogger('TSSRequestor');

// TSS Constants
const TSS_CONTROLLER_ACTION_URL = 'http://gs.apple.com/TSS/controller?action=2';
const TSS_CLIENT_VERSION_STRING = 'libauthinstall-1033.80.3';
const TSS_SUCCESS_MESSAGE = 'SUCCESS';
const TSS_REQUEST_TIMEOUT = 10000; // 10 seconds
const TSS_RULE_IGNORE_VALUE = 255;

export class TSSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TSSError';
  }
}

export class BuildIdentityNotFoundError extends TSSError {
  constructor(message: string) {
    super(message);
    this.name = 'BuildIdentityNotFoundError';
  }
}

export interface TSSResponse {
  [key: string]: any;
  ApImg4Ticket?: Buffer;
}

export interface RestoreRequestRule {
  Conditions?: {
    ApRawProductionMode?: boolean;
    ApCurrentProductionMode?: boolean;
    ApRawSecurityMode?: boolean;
    ApRequiresImage4?: boolean;
    ApDemotionPolicyOverride?: string;
    ApInRomDFU?: boolean;
    [key: string]: any;
  };
  Actions?: {
    [key: string]: any;
  };
}

export interface ManifestEntry {
  Info?: {
    RestoreRequestRules?: RestoreRequestRule[];
    [key: string]: any;
  };
  Digest?: Buffer;
  Trusted?: boolean;
  [key: string]: any;
}

export interface BuildManifest {
  LoadableTrustCache?: ManifestEntry;
  PersonalizedDMG?: ManifestEntry;
  [key: string]: ManifestEntry | undefined;
}

export class TSSRequest {
  private _request: PlistDictionary;

  constructor() {
    this._request = {
      '@HostPlatformInfo': 'mac',
      '@VersionInfo': TSS_CLIENT_VERSION_STRING,
      '@UUID': randomUUID().toUpperCase(),
    };
  }

  /**
   * Apply restore request rules to TSS entry
   * @param tssEntry The TSS entry to modify
   * @param parameters The parameters for rule evaluation
   * @param rules The rules to apply
   * @returns Modified TSS entry
   */
  static applyRestoreRequestRules(
    tssEntry: PlistDictionary,
    parameters: PlistDictionary,
    rules: RestoreRequestRule[],
  ): PlistDictionary {
    for (const rule of rules) {
      let conditionsFulfilled = true;
      const conditions = rule.Conditions || {};

      for (const [key, value] of Object.entries(conditions)) {
        if (!conditionsFulfilled) {
          break;
        }

        let value2: any;
        switch (key) {
          case 'ApRawProductionMode':
          case 'ApCurrentProductionMode':
            value2 = parameters.ApProductionMode;
            break;
          case 'ApRawSecurityMode':
            value2 = parameters.ApSecurityMode;
            break;
          case 'ApRequiresImage4':
            value2 = parameters.ApSupportsImg4;
            break;
          case 'ApDemotionPolicyOverride':
            value2 = parameters.DemotionPolicy;
            break;
          case 'ApInRomDFU':
            value2 = parameters.ApInRomDFU;
            break;
          default:
            log.error(
              `Unhandled condition ${key} while parsing RestoreRequestRules`,
            );
            value2 = null;
        }

        if (value2 !== null && value2 !== undefined) {
          conditionsFulfilled = value === value2;
        } else {
          conditionsFulfilled = false;
        }
      }

      if (!conditionsFulfilled) {
        continue;
      }

      const actions = rule.Actions || {};
      for (const [key, value] of Object.entries(actions)) {
        if (value !== TSS_RULE_IGNORE_VALUE) {
          const value2 = tssEntry[key];
          if (value2) {
            delete tssEntry[key];
          }
          log.debug(`Adding ${key}=${value} to TSS entry`);
          tssEntry[key] = value as any;
        }
      }
    }
    return tssEntry;
  }

  /**
   * Update the TSS request with additional options
   * @param options The options to add to the request
   */
  update(options: PlistDictionary): void {
    Object.assign(this._request, options);
  }

  /**
   * Send the TSS request to Apple's servers and receive the response
   * @returns Promise resolving to TSS response
   */
  async sendReceive(): Promise<TSSResponse> {
    const headers = {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/xml; charset="utf-8"',
      'User-Agent': 'InetURL/1.0',
      Expect: '',
    };

    log.info('Sending TSS request...');
    log.debug('TSS Request:', this._request);

    try {
      const requestDataStr = createPlist(this._request);
      const requestData =
        typeof requestDataStr === 'string'
          ? Buffer.from(requestDataStr, 'utf8')
          : requestDataStr;

      const res = await axios.post(TSS_CONTROLLER_ACTION_URL, requestData, {
        headers,
        timeout: TSS_REQUEST_TIMEOUT,
        responseType: 'text',
      });

      const response = res.data;
      log.debug(`TSS response status: ${res.status}`);

      if (response.includes('MESSAGE=SUCCESS')) {
        log.debug('TSS response successfully received');
      } else {
        log.warn('TSS response does not contain MESSAGE=SUCCESS');
      }

      const [, messagePart] = response.split('MESSAGE=');
      if (!messagePart) {
        throw new TSSError('Invalid TSS response format');
      }

      const [message] = messagePart.split('&');
      log.debug(`TSS server message: ${message}`);

      if (message !== TSS_SUCCESS_MESSAGE) {
        throw new TSSError(`TSS server replied: ${message}`);
      }

      const [, requestStringPart] = response.split('REQUEST_STRING=');
      if (!requestStringPart) {
        throw new TSSError('No REQUEST_STRING in TSS response');
      }

      return parsePlist(requestStringPart) as TSSResponse;
    } catch (error) {
      log.error('TSS request failed:', error);
      throw error;
    }
  }
}

/**
 * Get manifest from Apple's TSS (Ticket Signing Server)
 * @param personalizationIdentifiers The device personalization identifiers
 * @param buildManifest The build manifest dictionary
 * @param queryNonce Function to query nonce
 * @returns Promise resolving to the manifest bytes
 */
export async function getManifestFromTSS(
  personalizationIdentifiers: PlistDictionary,
  buildManifest: PlistDictionary,
  queryNonce: (personalizedImageType: string) => Promise<Buffer>,
): Promise<Buffer> {
  log.debug('Starting TSS manifest generation process');

  const request = new TSSRequest();

  for (const [key, value] of Object.entries(personalizationIdentifiers)) {
    if (key.startsWith('Ap,')) {
      request.update({ [key]: value });
    }
  }

  const ecid = personalizationIdentifiers.UniqueChipID as number;
  const boardId = personalizationIdentifiers.BoardId as number;
  const chipId = personalizationIdentifiers.ChipID as number;

  let buildIdentity: any = null;
  const buildIdentities = buildManifest.BuildIdentities as any[];

  for (const tmpBuildIdentity of buildIdentities) {
    // ApBoardID and ApChipID are hex strings, so parse with radix 16
    const apBoardId = parseInt(tmpBuildIdentity.ApBoardID, 16);
    const apChipId = parseInt(tmpBuildIdentity.ApChipID, 16);

    if (apBoardId === boardId && apChipId === chipId) {
      buildIdentity = tmpBuildIdentity;
      break;
    }
  }

  if (!buildIdentity) {
    throw new BuildIdentityNotFoundError(
      `Could not find the manifest for board ${boardId} and chip ${chipId}`,
    );
  }

  const manifest = buildIdentity.Manifest as BuildManifest;

  const parameters = {
    ApProductionMode: true,
    ApSecurityDomain: 1,
    ApSecurityMode: true,
    ApSupportsImg4: true,
    ApCurrentProductionMode: true,
    ApRequiresImage4: true,
    ApDemotionPolicyOverride: 'Demote',
    ApInRomDFU: true,
    ApRawSecurityMode: true,
  };

  const apNonce = await queryNonce('DeveloperDiskImage');

  request.update({
    '@ApImg4Ticket': true,
    '@BBTicket': true,
    ApBoardID: boardId,
    ApChipID: chipId,
    ApECID: ecid,
    ApNonce: apNonce,
    ApProductionMode: true,
    ApSecurityDomain: 1,
    ApSecurityMode: true,
    SepNonce: Buffer.alloc(20, 0), // 20 bytes of zeros
    UID_MODE: false,
  });

  for (const [key, manifestEntry] of Object.entries(manifest)) {
    if (!manifestEntry?.Info) {
      continue;
    }

    if (!manifestEntry.Trusted) {
      log.debug(`Skipping ${key} as it is not trusted`);
      continue;
    }

    log.debug(`Processing manifest entry: ${key}`);

    const tssEntry: PlistDictionary = {
      Digest: manifestEntry.Digest || Buffer.alloc(0),
      Trusted: manifestEntry.Trusted || false,
    };

    if (key === 'PersonalizedDMG') {
      tssEntry.Name = 'DeveloperDiskImage';
    }

    const loadableTrustCache = manifest.LoadableTrustCache;
    if (loadableTrustCache?.Info?.RestoreRequestRules) {
      const rules = loadableTrustCache.Info.RestoreRequestRules;
      if (rules.length > 0) {
        log.debug(`Applying restore request rules for entry ${key}`);
        TSSRequest.applyRestoreRequestRules(tssEntry, parameters, rules);
      }
    }

    request.update({ [key]: tssEntry });
  }

  const response = await request.sendReceive();

  if (!response.ApImg4Ticket) {
    throw new TSSError('TSS response does not contain ApImg4Ticket');
  }

  return response.ApImg4Ticket;
}
