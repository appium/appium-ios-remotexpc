import { BaseItem, strongbox } from '@appium/strongbox';

import {
  PAIR_RECORD_ITEM_PREFIX,
  STRONGBOX_CONTAINER_NAME,
} from '../../constants.js';
import { getLogger } from '../logger.js';

const log = getLogger('PairRecord');

/**
 * Interface defining the structure of a pair record.
 */
export interface PairRecord {
  HostID: string | null;
  SystemBUID: string | null;
  HostCertificate: string | null;
  HostPrivateKey: string | null;
  DeviceCertificate: string | null;
  RootCertificate: string | null;
  RootPrivateKey: string | null;
  WiFiMACAddress: string | null;
  EscrowBag: string | null;
}

/**
 * Interface for the raw response from plist.parsePlist
 */
export interface RawPairRecordResponse {
  HostID: string;
  SystemBUID: string;
  HostCertificate: Buffer;
  HostPrivateKey: Buffer;
  DeviceCertificate: Buffer;
  RootCertificate: Buffer;
  RootPrivateKey: Buffer;
  WiFiMACAddress: string;
  EscrowBag: Buffer;
}

/**
 * Processes raw response from plist.parsePlist and formats it into a proper pair-record
 * @param response - Response from plist.parsePlist(data.payload.PairRecordData)
 * @returns Formatted pair-record object with properly structured data
 */
export function processPlistResponse(
  response: RawPairRecordResponse,
): PairRecord {
  return {
    HostID: response.HostID || null,
    SystemBUID: response.SystemBUID || null,
    HostCertificate: response.HostCertificate
      ? bufferToPEMString(response.HostCertificate)
      : null,
    HostPrivateKey: response.HostPrivateKey
      ? bufferToPEMString(response.HostPrivateKey)
      : null,
    DeviceCertificate: response.DeviceCertificate
      ? bufferToPEMString(response.DeviceCertificate)
      : null,
    RootCertificate: response.RootCertificate
      ? bufferToPEMString(response.RootCertificate)
      : null,
    RootPrivateKey: response.RootPrivateKey
      ? bufferToPEMString(response.RootPrivateKey)
      : null,
    WiFiMACAddress: response.WiFiMACAddress || null,
    // For EscrowBag, we need it as a base64 string
    EscrowBag: response.EscrowBag
      ? response.EscrowBag.toString('base64')
      : null,
  };
}

/**
 * Saves a pair record to Strongbox (stable, environment-independent location).
 * @param udid - Device UDID.
 * @param pairRecord - Pair record to save.
 * @returns Promise that resolves when record is saved.
 */
export async function savePairRecord(
  udid: string,
  pairRecord: PairRecord,
): Promise<void> {
  const itemName = getItemName(udid);
  const item = new BaseItem(itemName, getBox());
  try {
    await item.write(JSON.stringify(pairRecord, null, 2));
    log.info(`Pair record saved: ${item.id}`);
  } catch (error) {
    log.error(`Failed to save pair record for ${udid}: ${error}`);
    throw error;
  }
}

/**
 * Gets a saved pair record from Strongbox.
 * @param udid - Device UDID.
 * @returns Promise that resolves with the pair record or null if not found.
 */
export async function getPairRecord(udid: string): Promise<PairRecord | null> {
  const itemName = getItemName(udid);
  const item = new BaseItem(itemName, getBox());
  try {
    const data = await item.read();
    return data ? (JSON.parse(data as string) as PairRecord) : null;
  } catch (error) {
    log.error(`Failed to read pair record for ${udid}: ${error}`);
    throw error;
  }
}

// #region Private helpers
let box: ReturnType<typeof strongbox> | undefined;

/**
 * Lazily initialize and return the strongbox container for pair records.
 */
function getBox(): ReturnType<typeof strongbox> {
  if (box === undefined) {
    box = strongbox(STRONGBOX_CONTAINER_NAME);
  }
  return box;
}

/**
 * Build the strongbox item key for a device pair record.
 */
function getItemName(udid: string): string {
  return `${PAIR_RECORD_ITEM_PREFIX}${udid}`;
}

/**
 * Converts a buffer containing PEM data to a string
 * @param buffer - Buffer containing PEM data
 * @returns String representation of the PEM data
 */
function bufferToPEMString(buffer: Buffer): string {
  return buffer.toString('utf8');
}
// #endregion
