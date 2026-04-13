/**
 * For duplicate UDIDs (USB + Wi‑Fi), order wired/USB before `Network` entries.
 * Among equal rank, input order is kept (stable). Does not mutate the original array.
 */
export function prioritizeUsbOverNetworkForDuplicateUdids<
  T extends {
    Properties: { SerialNumber: string; ConnectionType: string };
  },
>(devices: T[]): T[] {
  const result = [...devices];
  const indicesByUdid = new Map<string, number[]>();

  for (let i = 0; i < result.length; i++) {
    const udid = result[i].Properties.SerialNumber;
    let list = indicesByUdid.get(udid);
    if (!list) {
      list = [];
      indicesByUdid.set(udid, list);
    }
    list.push(i);
  }

  for (const indices of indicesByUdid.values()) {
    if (indices.length < 2) {
      continue;
    }
    const slice = indices.map((i) => result[i]);
    const sorted = stableSortByWirelessRank(slice);
    for (let k = 0; k < indices.length; k++) {
      result[indices[k]] = sorted[k];
    }
  }

  return result;
}

/** Stable sort by `wirelessRank` only (ties keep relative order). */
function stableSortByWirelessRank<
  T extends { Properties: { ConnectionType: string } },
>(items: T[]): T[] {
  return items
    .map((item, indexInSlice) => ({ item, indexInSlice }))
    .sort((a, b) => {
      const r = wirelessRank(a.item) - wirelessRank(b.item);
      if (r !== 0) {
        return r;
      }
      return a.indexInSlice - b.indexInSlice;
    })
    .map(({ item }) => item);
}

/** Wireless usbmux rows (same UDID as USB) use ConnectionType `Network`. */
function wirelessRank<T extends { Properties: { ConnectionType: string } }>(
  device: T,
): number {
  return device.Properties.ConnectionType === 'Network' ? 1 : 0;
}
