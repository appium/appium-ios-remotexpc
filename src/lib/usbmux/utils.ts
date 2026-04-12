/**
 * For duplicate UDIDs (USB + Wi‑Fi), order wired/USB before `Network` entries.
 * Preserves relative order of distinct UDIDs and the position of each group.
 */
export function prioritizeUsbOverNetworkForDuplicateUdids<
  T extends {
    Properties: { SerialNumber: string; ConnectionType: string };
  },
>(devices: T[]): T[] {
  const byUdid = new Map<string, T[]>();
  for (const d of devices) {
    const udid = d.Properties.SerialNumber;
    let g = byUdid.get(udid);
    if (!g) {
      g = [];
      byUdid.set(udid, g);
    }
    g.push(d);
  }

  const consumed = new Set<T>();
  const out: T[] = [];

  for (const d of devices) {
    if (consumed.has(d)) {
      continue;
    }
    const group = byUdid.get(d.Properties.SerialNumber);
    if (!group) {
      continue;
    }
    if (group.length === 1) {
      out.push(d);
      consumed.add(d);
      continue;
    }
    const sorted = [...group].sort((a, b) => wirelessRank(a) - wirelessRank(b));
    for (const x of sorted) {
      consumed.add(x);
      out.push(x);
    }
  }

  return out;
}

/** Wireless usbmux rows (same UDID as USB) use ConnectionType `Network`. */
function wirelessRank<T extends { Properties: { ConnectionType: string } }>(
  device: T,
): number {
  return device.Properties.ConnectionType === 'Network' ? 1 : 0;
}
