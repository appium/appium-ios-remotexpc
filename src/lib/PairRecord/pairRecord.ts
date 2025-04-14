import fs from 'fs';
import path from 'path';

/**
 * Interface defining the structure of a pair record
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

// Directory where pair records are stored
const RECORDS_DIR = path.join(process.cwd(), '../../.records');

/**
 * Decodes a base64 string to a Buffer
 * @param base64String - Base64 encoded string
 * @returns Decoded buffer
 */
export function decodeBase64(base64String: string): Buffer {
  return Buffer.from(base64String, 'base64');
}

/**
 * Parses raw pair record data into a structured PairRecord object
 * @param data - Raw pair record data
 * @returns Parsed pair record object
 */
export function parsePairRecord(data: Buffer): PairRecord {
  const dataStr = data.toString('utf8');

  const pairRecord: PairRecord = {
    HostID: null,
    SystemBUID: null,
    HostCertificate: null,
    HostPrivateKey: null,
    DeviceCertificate: null,
    RootCertificate: null,
    RootPrivateKey: null,
    WiFiMACAddress: null,
    EscrowBag: null
  };

  // Extract certificates
  const certMatches = dataStr.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g) || [];
  certMatches.forEach((cert, index) => {
    if (index === 0) pairRecord.DeviceCertificate = cert;
    if (index === 1) pairRecord.HostCertificate = cert;
    if (index === 2) pairRecord.RootCertificate = cert;
  });

  // Extract private keys
  const keyMatches = dataStr.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/g) || [];
  keyMatches.forEach((key, index) => {
    if (index === 0) pairRecord.HostPrivateKey = key;
    if (index === 1) pairRecord.RootPrivateKey = key;
  });

  // Extract SystemBUID
  const startIndex = dataStr.indexOf('SystemBUID_') + ('SystemBUID_'.length + 2);
  const endIndex = dataStr.indexOf('VHostID_', startIndex);
  if (startIndex > 0 && endIndex > startIndex) {
    pairRecord.SystemBUID = dataStr.substring(startIndex, endIndex);
  }

  // Extract HostID
  const startIndexHost = dataStr.indexOf('HostID_') + ('HostID_'.length + 2);
  const endIndexHost = dataStr.indexOf('YEscrowBag', startIndexHost);
  if (startIndexHost > 0 && endIndexHost > startIndexHost) {
    pairRecord.HostID = dataStr.substring(startIndexHost, endIndexHost);
  }

  // Extract WiFi MAC Address
  const startIndexWIFI = dataStr.indexOf('WiFiMACAddress_') + ('WiFiMACAddress_'.length + 2);
  const endIndexWIFI = dataStr.indexOf('/', startIndexWIFI);
  if (startIndexWIFI > 0 && endIndexWIFI > startIndexWIFI) {
    pairRecord.WiFiMACAddress = dataStr.substring(startIndexWIFI, endIndexWIFI);
  }

  return pairRecord;
}

/**
 * Decodes a base64 encoded plist pair record
 * @param base64PlistData - Base64 encoded plist data
 * @returns Parsed pair record object
 */
export function decodePlistPairRecord(base64PlistData: string): PairRecord {
  try {
    const binaryData = decodeBase64(base64PlistData);
    return parsePairRecord(binaryData);
  } catch (error) {
    console.error('Error decoding pair record:', error);
    throw error;
  }
}

/**
 * Ensures the records directory exists
 * @returns Promise that resolves when directory is ready
 */
async function ensureRecordsDirectoryExists(): Promise<void> {
  try {
    await fs.promises.mkdir(RECORDS_DIR, { recursive: true, mode: 0o755 });
  } catch (error) {
    console.error(`Failed to create directory ${RECORDS_DIR}:`, error);
    throw error;
  }
}

/**
 * Saves a pair record to the filesystem
 * @param udid - Device UDID
 * @param pairRecord - Pair record to save
 * @returns Promise that resolves when record is saved
 */
export async function savePairRecord(udid: string, pairRecord: PairRecord): Promise<void> {
  await ensureRecordsDirectoryExists();
  
  const recordPath = path.join(RECORDS_DIR, `${udid}-record.json`);
  try {
    await fs.promises.writeFile(
      recordPath, 
      JSON.stringify(pairRecord, null, 2),
      { mode: 0o644 }
    );
    console.log(`Pair record saved: ${recordPath}`);
  } catch (error) {
    console.error(`Failed to save pair record for ${udid}:`, error);
    throw error;
  }
}

/**
 * Gets a saved pair record from the filesystem
 * @param udid - Device UDID
 * @returns Promise that resolves with the pair record or null if not found
 */
export async function getPairRecord(udid: string): Promise<PairRecord | null> {
  const recordPath = path.join(RECORDS_DIR, `${udid}-record.json`);
  
  try {
    const data = await fs.promises.readFile(recordPath, 'utf8');
    return JSON.parse(data) as PairRecord;
  } catch (error) {
    // If file doesn't exist, return null
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    
    console.error(`Failed to read pair record for ${udid}:`, error);
    throw error;
  }
}