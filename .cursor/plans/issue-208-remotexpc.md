# Issue #208 — appium-ios-remotexpc plan

**Issue:** [appium/appium-ios-remotexpc#208](https://github.com/appium/appium-ios-remotexpc/issues/208)  
**Companion plan (xcuitest driver):** `/Users/elf/code/appium-xcuitest-driver/.cursor/plans/issue-208-xcuitest-driver.md`

## Problem (this repo)

`remoted` allows effectively **one RSD discovery connection** per tunnel. `RemoteXpcConnection` is single-use: open → handshake → discover ports → **close**. Per-service work uses separate TCP sockets on `tunnelHost`.

PR [#209](https://github.com/appium/appium-ios-remotexpc/pull/209) added `withRemoteXpcConnection` for AFC/syslog only. Most `start*Service` helpers still return a leaked `remoteXPC`, which encourages consumers (xcuitest-driver) to hold discovery sockets open → `ECONNRESET`, tunnel death, `ENETUNREACH`.

## Goal

All port-discovery helpers close the discovery RSD before returning. Export a tunnel lockdown helper that does not require callers to keep RSD open. Add a safety mutex and harden tunnel health checks.

## Tasks

### 1. Refactor `start*Service` to `withRemoteXpcConnection`

**File:** [`src/services.ts`](../../src/services.ts)

Pattern (already used by `startAfcService`):

```typescript
export async function startInstallationProxyService(udid: string): Promise<InstallationProxyService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(InstallationProxyService.RSD_SERVICE_NAME);
    return new InstallationProxyService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}
```

Apply to helpers that only need port discovery (priority for xcuitest session start):

- `startInstallationProxyService`
- `startNotificationProxyService`
- `startCrashReportsService`
- `startHouseArrestService`
- `startMobileConfigService`
- `startDiagnosticsService`
- Remaining helpers that returned `remoteXPC` without a long-lived need

**File:** [`src/lib/types.ts`](../../src/lib/types.ts)

- Remove `*WithConnection` types; `startDVTService` returns `DVTInstruments`.
- Document breaking change in changelog (semver minor).

`startXCTestServices` already closes RSD in a `finally` block — align other multi-port helpers (e.g. crash reports: two ports in one RSD pass) with a single `withRemoteXpcConnection` callback.

### 2. Tunnel lockdown helper

**File:** [`src/lib/lockdown/index.ts`](../../src/lib/lockdown/index.ts)

Add and export:

```typescript
export async function createLockdownServiceForTunnel(udid: string): Promise<LockdownService> {
  return withRemoteXpcConnection(udid, (remoteXPC) =>
    createLockdownServiceByTunnel(remoteXPC, udid));
}
```

- Keep `createLockdownServiceByTunnel(remoteXpc, udid)` for advanced use; document that callers **must** `close()` `remoteXpc` if they supply their own.
- Export from [`src/index.ts`](../../src/index.ts).

`withRemoteXpcConnection` must be exported or duplicated in lockdown module — prefer exporting from `services.ts` or a small shared internal module.

### 3. RSD connection mutex

**File:** [`src/lib/tunnel/index.ts`](../../src/lib/tunnel/index.ts)

Per-tunnel `rsdSessionLockKey` + `runSerializedRsdSession` / `withRemoteXpcConnection`:

- Maintain `Map<lockKey, Promise<void>>` so concurrent discovery on the same tunnel **queue** instead of racing `remoted`.
- **Removed** `Services.createRemoteXPCConnection` and leased `TunnelManager.createRemoteXPCConnection`; use `getTunnelForDevice(udid)` for registry metadata only.

### 4. Harden `RemoteXpcConnection.close()`

**File:** [`src/lib/remote-xpc/remote-xpc-connection.ts`](../../src/lib/remote-xpc/remote-xpc-connection.ts)

- `_isClosing` to avoid logging `ECONNRESET` during intentional shutdown.
- Swallow transport errors on close path; keep `cleanupSocket` / `forceCleanup` behavior.

### 5. Tunnel registry RSD probe

**File:** [`src/lib/tunnel/tunnel-registry-lifecycle.ts`](../../src/lib/tunnel/tunnel-registry-lifecycle.ts)

Reporter gist shows premature `Tunnel registry: removed … (RSD probe failed)` while tunnel is still usable.

- Require **2–3 consecutive** failed probes before removing registry entry, **or**
- Rely on CoreDeviceProxy socket `close`/`error` only and disable/lengthen RSD probe interval.

### 6. Tests

**File:** [`test/unit/services/start-services-cleanup.spec.ts`](../../test/unit/services/start-services-cleanup.spec.ts)

- Assert `remoteXPC.close()` called for `startInstallationProxyService`, `startNotificationProxyService`, `startCrashReportsService`.
- Unit test: parallel `runSerializedRsdSession` → serialized via mutex.

### 7. Release

- Patch/minor bump per API break scope.
- Changelog: removed `*WithConnection` types and `createRemoteXPCConnection`; `startDVTService` → `DVTInstruments`; `createLockdownServiceForTunnel(udid)`.

## API contract for xcuitest (downstream)

After this release, consumers should assume:

| Before | After |
|--------|--------|
| `{ installationProxyService, remoteXPC }` | `installationProxyService` only |
| `createRemoteXPCConnection(udid)` | `getTunnelForDevice(udid)` or `createLockdownServiceForTunnel(udid)` |
| Multiple parallel RSD connects OK | Serialized + discouraged; one open/close per operation |

**Minimum version tag for xcuitest:** note in release (e.g. `1.1.11` or `1.2.0`).

## Verification (this repo)

- Unit tests pass.
- Optional integration: tunnel + sequential `startInstallationProxyService` / `startAfcService` without `ECONNRESET`.

## Reference

- pymobiledevice3: RSD closed after `RemoteServiceDiscoveryService.connect()`; services use `ServiceConnection.create_using_tcp(host, port)`.
- Partial fix: commit `245ad73` (PR #209).
