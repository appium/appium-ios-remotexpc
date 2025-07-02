# appium-ios-remotexpc

A Node.js library for interacting with iOS devices
through Appium using remote XPC services.
This library enables communication with iOS devices
through various services like system logs and network tunneling.

## Overview

This library provides functionality for:

- Remote XPC (Cross Process Communication) with iOS devices
- Lockdown communication
- USB device multiplexing (usbmux)
- Property list (plist) handling
- IPv6 tunneling services to iOS devices using TUN/TAP interfaces
- System log access

## Installation

```bash
npm install appium-ios-remotexpc
```

## Requirements

- Node.js 16 or later
- iOS device for testing
- Proper device pairing and trust setup
- Root/sudo privileges for tunnel creation (TUN/TAP interface requires elevated permissions)

## Features

- **Plist Handling**: Encode, decode, parse, and create property lists for iOS device communication.
- **USB Device Communication**: Connect to iOS devices over USB using the usbmux protocol.
- **Remote XPC**: Establish Remote XPC connections with iOS devices.
- **Service Architecture**: Connect to various iOS services:
    - System Log Service: Access device logs
    - Tunnel Service: Network tunneling to/from iOS devices
    - Diagnostic Service: Device diagnostics
- **Pair Record Management**: Read and write device pairing records.
- **Packet Streaming**: Stream packets between host and device for service communication.

## Architecture Flow

The following diagram illustrates the high-level flow of how the tunnel is created:

<div align="center">
  <img src="assets/images/ios-arch.png" alt="iOS Architecture" width="70%">
</div>

### Role of TUN/TAP

The `appium-ios-tuntap (previously tuntap-bridge)` module plays a crucial role in establishing network connectivity:

1. **TLS Socket Input**: Receives the secure TLS socket connection from CoreDeviceProxy
2. **Virtual Network Interface**: Creates a TUN/TAP virtual network interface on the host system
3. **IPv6 Tunnel**: Establishes an IPv6 tunnel between the host and iOS device
4. **Packet Routing**: Routes network packets between the virtual interface and the iOS device
5. **Service Access**: Enables access to iOS shim services through the tunnel

**Technical Details:**
- **Platform Support**: Works on both macOS and Linux
- **IPv6 Support**: Creates IPv6 tunnels for modern iOS communication
- **Packet Handling**: Manages packet routing between virtual interface and device
- **Automatic Cleanup**: Properly closes tunnels and cleans up interfaces

**Security Considerations:**
- Requires root/sudo access for TUN/TAP interface creation
- Uses TLS for secure communication with iOS devices

## Usage

### Creating a Tunnel (Low-level approach)

```typescript
import { createLockdownServiceByUDID, startCoreDeviceProxy, TunnelManager } from 'appium-ios-remotexpc';

// Create lockdown service
const { lockdownService, device } = await createLockdownServiceByUDID(udid);

// Start CoreDeviceProxy
const { socket } = await startCoreDeviceProxy(
  lockdownService,
  device.DeviceID,
  device.Properties.SerialNumber,
  { rejectUnauthorized: false }
);

// Create tunnel using tuntap
const tunnel = await TunnelManager.getTunnel(socket);
console.log(`Tunnel created at ${tunnel.Address} with RSD port ${tunnel.RsdPort}`);

// Create RemoteXPC connection
const remoteXPC = await TunnelManager.createRemoteXPCConnection(
  tunnel.Address,
  tunnel.RsdPort
);

// Access services
const services = remoteXPC.getServices();
```

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/appium-ios-remotexpc.git
cd appium-ios-remotexpc

# Install dependencies
npm install

# Build the project
npm run build
```

### Continuous Integration

This project uses GitHub Actions for continuous integration and Dependabot for dependency management:

- **Lint and Build**: Automatically runs linting and builds the project on Node.js LTS.
- **Format Check**: Ensures code formatting adheres to project standards
- **Test Validation**: Validates that test files compile correctly (actual tests require physical devices)
- **Dependabot**: Automatically creates PRs for dependency updates weekly

All pull requests must pass these checks before merging. The workflows are defined in the `.github/workflows` directory.

### Scripts

- `npm run build` - Clean and build the project
- `npm run lint` - Run ESLint
- `npm run format` - Run prettier
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm test` - Run tests (requires sudo privileges for tunneling)
- `npm run test:tunnel-creation` - Create tunnels for testing (requires sudo)

## Project Structure

- `/src` - Source code
  - `/lib` - Core libraries
    - `/lockdown` - Device lockdown protocol
    - `/pair-record` - Pairing record handling
    - `/plist` - Property list processing
    - `/remote-xpc` - XPC connection handling
    - `/tunnel` - Tunneling implementation with tuntap integration
    - `/usbmux` - USB multiplexing protocol
  - `/services` - Service implementations
    - `/ios`
      - `/diagnostic-service` - Device diagnostics
      - `/syslog-service` - System log access
      - `/tunnel-service` - Network tunneling

## Testing

```bash
# Run all tests
npm test
```

Note: Integration tests require:
- Physical iOS devices connected
- Sudo privileges for tunnel creation
- Device trust established

## License

Apache-2.0

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Notes

This project is under active development. APIs may change without notice.
