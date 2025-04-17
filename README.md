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
- Tunneling services to iOS devices
- System log access

## Installation

```bash
npm install appium-ios-remotexpc
```

## Requirements

- Node.js 16 or later
- iOS device for testing
- Proper device pairing and trust setup

## Features

- **Plist Handling**: Encode, decode, parse, and create property lists for iOS device communication.
- **USB Device Communication**: Connect to iOS devices over USB using the usbmux protocol.
- **Remote XPC**: Establish Remote XPC connections with iOS devices.
- **Service Architecture**: Connect to various iOS services:
  - System Log Service: Access device logs
  - Tunnel Service: Network tunneling to/from iOS devices
- **Pair Record Management**: Read and write device pairing records.

## Usage

```typescript
import { TunnelService } from 'appium-ios-remotexpc';

// Create a tunnel to an iOS device
const tunnelService = new TunnelService();
await tunnelService.startService();

// Do operations with the tunnel
// ...

// Close the tunnel when done
await tunnelService.stopService();
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

### Scripts

- `npm run build` - Clean and build the project
- `npm run lint` - Run ESLint
- `npm run format` - Run prettier
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm test` - Run tests (requires sudo privileges for tunneling)

## Project Structure

- `/src` - Source code
  - `/lib` - Core libraries
    - `/Lockdown` - Device lockdown protocol
    - `/PairRecord` - Pairing record handling
    - `/Plist` - Property list processing
    - `/RemoteXPC` - XPC connection handling
    - `/Tunnel` - Tunneling implementation
    - `/usbmux` - USB multiplexing protocol
  - `/Services` - Service implementations
    - `/IOS`
      - `/syslogService` - System log access
      - `/tunnelService` - Network tunneling

## Testing

```bash
npm test
```

Note: Testing the tunnel service requires sudo privileges.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Notes

This project is under active development. APIs may change without notice.
