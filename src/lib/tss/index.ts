import { logger } from '@appium/support';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';

import { createPlist, parsePlist } from '../plist/index.js';
import type { PlistDictionary } from '../types.js';

const log = logger.getLogger('TSSRequestor');

// TSS Constants
const TSS_CONTROLLER_ACTION_URL = 'http://gs.apple.com/TSS/controller?action=2';
const TSS_CLIENT_VERSION_STRING = 'libauthinstall-1033.80.3';

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
    rules: any[],
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
        if (value !== 255) {
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

      const response = await this.httpRequest(TSS_CONTROLLER_ACTION_URL, {
        method: 'POST',
        headers,
        body: requestData,
      });

      if (response.includes('MESSAGE=SUCCESS')) {
        log.debug('TSS response successfully received');
      } else {
        log.warn('TSS response does not contain MESSAGE=SUCCESS');
      }

      const responseStr = response.toString();
      const messagePart = responseStr.split('MESSAGE=')[1];
      if (!messagePart) {
        log.error('Invalid TSS response format - no MESSAGE field found');
        throw new Error('Invalid TSS response format');
      }

      const message = messagePart.split('&')[0];
      log.debug(`TSS server message: ${message}`);

      if (message !== 'SUCCESS') {
        log.error(`TSS server replied with error: ${message}`);
        throw new Error(`TSS server replied: ${message}`);
      }

      const requestStringPart = responseStr.split('REQUEST_STRING=')[1];
      if (!requestStringPart) {
        log.error('No REQUEST_STRING in TSS response');
        throw new Error('No REQUEST_STRING in TSS response');
      }

      const responseData = parsePlist(requestStringPart) as TSSResponse;
      log.debug('TSS response parsed successfully');

      return responseData;
    } catch (error) {
      log.error('TSS request failed:', error);
      throw error;
    }
  }

  /**
   * Make HTTP request using Node.js built-in modules
   * @param url The URL to request
   * @param options Request options
   * @returns Promise resolving to response body
   */
  private httpRequest(
    url: string,
    options: { method: string; headers: Record<string, string>; body: Buffer },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;

      // Set timeout to 10 seconds to allow for TSS processing
      const timeout = 10000;

      log.debug(`Making TSS request to ${url}`);

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: options.method,
          timeout,
          headers: {
            ...options.headers,
            'Content-Length': options.body.length,
          },
        },
        (res) => {
          log.debug(`TSS response status: ${res.statusCode}`);

          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();

            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            } else {
              resolve(body);
            }
          });
        },
      );

      req.on('error', (error) => {
        log.error('TSS request error:', error);
        reject(error);
      });

      req.on('timeout', () => {
        log.error(`TSS request timed out after ${timeout}ms`);
        req.destroy();
        reject(new Error(`TSS request timed out after ${timeout}ms`));
      });

      req.write(options.body);
      req.end();
    });
  }
}

/**
 * Get manifest from Apple's TSS (Ticket Signing Server)
 * @param ecid The device ECID
 * @param buildManifest The build manifest dictionary
 * @param queryPersonalizationIdentifiers Function to query personalization identifiers
 * @param queryNonce Function to query nonce
 * @returns Promise resolving to the manifest bytes
 */
export async function getManifestFromTSS(
  ecid: number,
  buildManifest: PlistDictionary,
  queryPersonalizationIdentifiers: () => Promise<PlistDictionary>,
  queryNonce: (personalizedImageType: string) => Promise<Buffer>,
): Promise<Buffer> {
  log.debug('Starting TSS manifest generation process');

  const request = new TSSRequest();

  const personalizationIdentifiers = await queryPersonalizationIdentifiers();
  for (const [key, value] of Object.entries(personalizationIdentifiers)) {
    if (key.startsWith('Ap,')) {
      request.update({ [key]: value });
    }
  }

  const boardId = personalizationIdentifiers.BoardId as number;
  const chipId = personalizationIdentifiers.ChipID as number;

  let buildIdentity: any = null;
  const buildIdentities = buildManifest.BuildIdentities as any[];

  for (const tmpBuildIdentity of buildIdentities) {
    const apBoardId = parseInt(tmpBuildIdentity.ApBoardID, 10);
    const apChipId = parseInt(tmpBuildIdentity.ApChipID, 10);

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

  const manifest = buildIdentity.Manifest;

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
    const infoDict = (manifestEntry as any).Info;
    if (!infoDict) {
      continue;
    }

    if (!(manifestEntry as any).Trusted) {
      log.debug(`Skipping ${key} as it is not trusted`);
      continue;
    }

    log.debug(`Processing manifest entry: ${key}`);

    // Start with minimal TSS entry - only copy essential fields
    const tssEntry: PlistDictionary = {
      Digest: (manifestEntry as any).Digest || Buffer.alloc(0),
      Trusted: (manifestEntry as any).Trusted || false,
    };

    if (key === 'PersonalizedDMG') {
      tssEntry.Name = 'DeveloperDiskImage';
    }

    const loadableTrustCache = manifest.LoadableTrustCache as any;
    if (
      loadableTrustCache &&
      loadableTrustCache.Info &&
      loadableTrustCache.Info.RestoreRequestRules
    ) {
      const rules = loadableTrustCache.Info.RestoreRequestRules;
      if (rules && rules.length > 0) {
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
