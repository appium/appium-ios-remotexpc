## Summary

Fixes #208 — session startup failures (`ECONNRESET`, handshake errors, `ENETUNREACH`) when a CoreDevice tunnel is already running and multiple consumers held or raced the **RSD discovery** connection on the same tunnel.

`remoted` allows **one RSD discovery session per tunnel** at a time (connect → handshake → `findService` → close). Per-service work uses separate TCP sockets on `tunnelHost`. This release makes that contract explicit in the library: discovery is short-lived, serialized per tunnel endpoint, and no longer leaked through public APIs.

**Recommended release:** `2.0.0` (semver major).

---

## Motivation

- `start*Service` helpers previously returned `{ service, remoteXPC }`, encouraging callers (e.g. appium-xcuitest-driver) to keep discovery RSD open across `InstallationProxy`, `Notification`, `Lockdown`, syslog, crash logs, etc.
- Parallel discovery on the same `host:rsdPort` raced `remoted` and broke unrelated probes.
- Tunnel registry could remove a healthy tunnel after a single failed RSD probe while discovery was busy.

---

## Breaking changes (conventional commits)

Each item below is an independent **breaking** commit message you can use when squashing or splitting history. Prefix with `!` or include `BREAKING CHANGE:` in the footer per [Conventional Commits](https://www.conventionalcommits.org/).

### Removed

```
feat!(services)!: remove Services.createRemoteXPCConnection(udid)

BREAKING CHANGE: `Services.createRemoteXPCConnection(udid)` is removed. It returned `{ remoteXPC, tunnelConnection }` and allowed leaking the discovery RSD. Use `getTunnelForDevice(udid)` for registry metadata only, `withRemoteXpcConnection(udid, fn)` for custom discovery, or `createLockdownServiceForTunnel(udid)` for lockdown.
```

```
feat!(tunnel)!: remove TunnelManager.createRemoteXPCConnection(host, port)

BREAKING CHANGE: `TunnelManager.createRemoteXPCConnection(address, rsdPort)` is removed. Leased discovery connections are no longer part of the public API. Use `TunnelManager.runSerializedRsdSession(lockKey, fn)` with `connectRemoteXPCUnlocked` (low-level), or prefer `withRemoteXpcConnection` from the package root.
```

```
refactor!(types)!: remove all *WithConnection type aliases

BREAKING CHANGE: Removed exported types: `DiagnosticsServiceWithConnection`, `NotificationProxyServiceWithConnection`, `MobileConfigServiceWithConnection`, `PowerAssertionServiceWithConnection`, `WebInspectorServiceWithConnection`, `MobileImageMounterServiceWithConnection`, `HouseArrestServiceWithConnection`, `SpringboardServiceWithConnection`, `MisagentServiceWithConnection`, `CrashReportsServiceWithConnection`, `InstallationProxyServiceWithConnection`, `TestmanagerdServiceWithConnection`. Use the service types returned directly from `start*Service`.
```

```
refactor!(types)!: rename DVTServiceWithConnection to DVTInstruments

BREAKING CHANGE: `DVTServiceWithConnection` is renamed to `DVTInstruments`. Update imports and type annotations. `startDVTService(udid)` return type is now `Promise<DVTInstruments>`.
```

### Changed return types (`start*Service`)

All helpers below previously returned a `*WithConnection` object that included `remoteXPC`. They now return **only the service instance** (discovery RSD is opened and closed internally).

```
feat!(services)!: startDiagnosticsService returns DiagnosticsService only

BREAKING CHANGE: Return type changed from `DiagnosticsServiceWithConnection` to `DiagnosticsService`. Do not expect or close `remoteXPC`.
```

```
feat!(services)!: startNotificationProxyService returns NotificationProxyService only

BREAKING CHANGE: Return type changed from `NotificationProxyServiceWithConnection` to `NotificationProxyService`.
```

```
feat!(services)!: startMobileConfigService returns MobileConfigService only

BREAKING CHANGE: Return type changed from `MobileConfigServiceWithConnection` to `MobileConfigService`.
```

```
feat!(services)!: startMobileImageMounterService returns MobileImageMounterService only

BREAKING CHANGE: Return type changed from `MobileImageMounterServiceWithConnection` to `MobileImageMounterService`.
```

```
feat!(services)!: startSpringboardService returns SpringboardService only

BREAKING CHANGE: Return type changed from `SpringboardServiceWithConnection` to `SpringboardService`.
```

```
feat!(services)!: startMisagentService returns MisagentService only

BREAKING CHANGE: Return type changed from `MisagentServiceWithConnection` to `MisagentService`.
```

```
feat!(services)!: startPowerAssertionService returns PowerAssertionService only

BREAKING CHANGE: Return type changed from `PowerAssertionServiceWithConnection` to `PowerAssertionService`.
```

```
feat!(services)!: startWebInspectorService returns WebInspectorService only

BREAKING CHANGE: Return type changed from `WebInspectorServiceWithConnection` to `WebInspectorService`.
```

```
feat!(services)!: startHouseArrestService returns HouseArrestService only

BREAKING CHANGE: Return type changed from `HouseArrestServiceWithConnection` to `HouseArrestService`.
```

```
feat!(services)!: startInstallationProxyService returns InstallationProxyService only

BREAKING CHANGE: Return type changed from `InstallationProxyServiceWithConnection` to `InstallationProxyService`.
```

```
feat!(services)!: startCrashReportsService returns CrashReportsService only

BREAKING CHANGE: Return type changed from `CrashReportsServiceWithConnection` to `CrashReportsService`.
```

```
feat!(services)!: startTestmanagerdService returns DvtTestmanagedProxyService only

BREAKING CHANGE: Return type changed from `TestmanagerdServiceWithConnection` (or `{ testmanagerdService, remoteXPC }`) to `DvtTestmanagedProxyService` only.
```

```
feat!(services)!: startDVTService returns DVTInstruments without remoteXPC

BREAKING CHANGE: `startDVTService` returns `DVTInstruments` (renamed from `DVTServiceWithConnection`). The `remoteXPC` field is removed; close `dvtService` and instrument clients when done.
```

```
refactor!(services)!: startXCTestServices uses scoped discovery for port lookup

BREAKING CHANGE: Port discovery for XCTest services runs inside `withRemoteXpcConnection` (no leaked discovery RSD). Returned `XCTestServices` shape is unchanged; callers must not assume a separate discovery connection remains open.
```

### Added public APIs

```
feat(services): add getTunnelForDevice(udid)

Export tunnel registry metadata (`host`, `port`, `packetStreamPort`) without opening RSD. Replaces misuse of `createRemoteXPCConnection` when only `tunnelConnection.host` was needed.
```

```
feat(services): export withRemoteXpcConnection(udid, fn)

Run connect → `findService` → `close` under the per-tunnel RSD lock. Discovery connection is always closed in `finally`.
```

```
feat(lockdown): add createLockdownServiceForTunnel(udid)

One-shot lockdown over tunnel without holding discovery RSD after return. Prefer over `createLockdownServiceByTunnel(remoteXPC, udid)` with a long-lived `RemoteXpcConnection`.
```

```
feat(tunnel): add rsdSessionLockKey, runSerializedRsdSession, connectRemoteXPCUnlocked

Per-tunnel queue serializes full discovery windows on `host:rsdPort`. `connectRemoteXPCUnlocked` requires the caller to already hold the session lock (via `runSerializedRsdSession` or `withRemoteXpcConnection`).
```

```
feat(types): export TunnelEndpoint from package entry

Tunnel registry DTO (`host`, `port`, `udid`, `packetStreamPort`) is now a named public export.
```

### Behavior changes (may affect callers without API renames)

```
fix(tunnel)!: serialize RSD discovery per tunnel endpoint

BREAKING CHANGE: Concurrent `withRemoteXpcConnection` / `start*Service` calls on the same tunnel are queued until the previous discovery session has closed. Code that relied on overlapping discovery will run sequentially (correct for `remoted`).
```

```
fix(tunnel-registry)!: require consecutive RSD probe failures before removing tunnel

BREAKING CHANGE: Default `rsdProbeFailureThreshold` is `3`. A single failed probe no longer removes a registry entry. Tunables: `rsdProbeFailureThreshold`, `rsdProbeIntervalMs`, `rsdProbeConnectTimeoutMs` on `watchTunnelRegistrySockets`.
```

---

## Migration guide

| Before | After |
|--------|--------|
| `const { installationProxyService, remoteXPC } = await Services.startInstallationProxyService(udid)` | `const installationProxyService = await Services.startInstallationProxyService(udid)` |
| `const { remoteXPC, tunnelConnection } = await Services.createRemoteXPCConnection(udid)` | `const tunnel = await getTunnelForDevice(udid)` **or** `await withRemoteXpcConnection(udid, fn)` |
| Long-lived `createRemoteXPCConnection` in `LockdownClient` | `await createLockdownServiceForTunnel(udid)` per operation |
| `DVTServiceWithConnection` | `DVTInstruments` |
| `TunnelManager.createRemoteXPCConnection(addr, port)` | `runSerializedRsdSession(rsdSessionLockKey(addr, port), async () => { ... connectRemoteXPCUnlocked ... close })` |
| Port forward setup: open RSD only to read `tunnelConnection.host` | `getTunnelForDevice(udid).host` |

**appium-xcuitest-driver:** bump to this release and follow `.cursor/plans/issue-208-xcuitest-driver.md` (or equivalent) — stop storing `remoteXpcConnection`, update `device-connections-factory`, `condition-inducer-client`, `network-monitor-session`, and parallel session startup paths.

---

## Test plan

- [x] `npm run build`
- [x] `npm run lint`
- [x] `npm run test:unit` (401 tests)
- [ ] Integration tests with `UDID` + active tunnel (`tunnel-creation` script)
- [ ] appium-xcuitest-driver: `fullReset` session without `ECONNRESET` / `ENETUNREACH` on iOS 18+ real device with existing tunnel

---

## Related

- Issue: #208
- Prior fix (partial): #209 — close discovery RSD in `start*Service` helpers
- Downstream: appium-xcuitest-driver issue-208 plan
