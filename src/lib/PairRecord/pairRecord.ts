import fs from 'fs';
import path from 'path';

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
 * Decodes a base64 string to a Buffer.
 * @param base64String - Base64 encoded string.
 * @returns Decoded Buffer.
 */
export function decodeBase64(base64String: string): Buffer {
    return Buffer.from(base64String, 'base64');
}

/**
 * Helper function to decode a value to PEM text.
 * If the value does not start with "-----BEGIN", it attempts a base64 decode.
 * @param value - The string to potentially decode.
 * @returns The decoded PEM string if successful, or the original value.
 */
function decodePEMValue(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("-----BEGIN")) {
        try {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
            if (decoded.trim().startsWith("-----BEGIN")) {
                return decoded;
            }
        } catch (err) {
            console.error("Error decoding PEM value:", err);
        }
    }
    return value;
}

/**
 * Parses a plist XML buffer into a structured PairRecord object.
 * Uses a regex to extract key/value pairs from the plist and decodes PEM values.
 * @param data - Raw plist XML data as a Buffer.
 * @returns Parsed pair record object.
 */
export function parsePairRecord(data: Buffer): PairRecord {
    const dataStr = data.toString('utf8');
    const record: Partial<PairRecord> = {};

    // Matches key/value pairs where the value is contained in a <string> or <data> element.
    const regex = /<key>(.*?)<\/key>\s*<(string|data)>([\s\S]*?)<\/(?:string|data)>/g;
    let match;
    while ((match = regex.exec(dataStr)) !== null) {
        const key = match[1];
        const value = match[3].trim();
        switch (key) {
            case 'HostID':
                record.HostID = value;
                break;
            case 'SystemBUID':
                record.SystemBUID = value;
                break;
            case 'HostCertificate':
                record.HostCertificate = decodePEMValue(value);
                break;
            case 'HostPrivateKey':
                record.HostPrivateKey = decodePEMValue(value);
                break;
            case 'DeviceCertificate':
                record.DeviceCertificate = decodePEMValue(value);
                break;
            case 'RootCertificate':
                record.RootCertificate = decodePEMValue(value);
                break;
            case 'RootPrivateKey':
                record.RootPrivateKey = decodePEMValue(value);
                break;
            case 'WiFiMACAddress':
                record.WiFiMACAddress = value;
                break;
            case 'EscrowBag':
                record.EscrowBag = value;
                break;
            // Ignore any keys we don't care about.
            default:
                break;
        }
    }

    return {
        HostID: record.HostID || null,
        SystemBUID: record.SystemBUID || null,
        HostCertificate: record.HostCertificate || null,
        HostPrivateKey: record.HostPrivateKey || null,
        DeviceCertificate: record.DeviceCertificate || null,
        RootCertificate: record.RootCertificate || null,
        RootPrivateKey: record.RootPrivateKey || null,
        WiFiMACAddress: record.WiFiMACAddress || null,
        EscrowBag: record.EscrowBag || null,
    };
}

/**
 * Decodes a base64 encoded plist pair record.
 * Accepts input as either a base64 string or a Buffer.
 * @param data - Base64 encoded plist data as a string or a Buffer.
 * @returns Parsed pair record object.
 */
export function decodePlistPairRecord(data: Buffer | string): PairRecord {
    try {
        const binaryData: Buffer = typeof data === 'string' ? decodeBase64(data) : data;
        return parsePairRecord(binaryData);
    } catch (error) {
        console.error('Error decoding pair record:', error);
        throw error;
    }
}

/* --- File storage functions remain unchanged --- */

const RECORDS_DIR = path.join(process.cwd(), '../../.records');

async function ensureRecordsDirectoryExists(): Promise<void> {
    try {
        await fs.promises.mkdir(RECORDS_DIR, { recursive: true, mode: 0o777 });
    } catch (error) {
        console.error(`Failed to create directory ${RECORDS_DIR}:`, error);
        throw error;
    }
}

/**
 * Saves a pair record to the filesystem.
 * @param udid - Device UDID.
 * @param pairRecord - Pair record to save.
 * @returns Promise that resolves when record is saved.
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
 * Gets a saved pair record from the filesystem.
 * @param udid - Device UDID.
 * @returns Promise that resolves with the pair record or null if not found.
 */
export async function getPairRecord(udid: string): Promise<PairRecord | null> {
    const recordPath = path.join(RECORDS_DIR, `${udid}-record.json`);

    try {
        const data = await fs.promises.readFile(recordPath, 'utf8');
        return JSON.parse(data) as PairRecord;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        console.error(`Failed to read pair record for ${udid}:`, error);
        throw error;
    }
}
