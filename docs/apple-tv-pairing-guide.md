# Apple TV Pairing Instructions

This comprehensive guide will walk you through the process of pairing your Apple TV device for remote testing and automation using this project.

## Overview

Apple TV pairing establishes a secure connection between your development machine and the Apple TV device. This pairing process uses cryptographic protocols to ensure secure communication over the network. Once paired, the generated pair record allows you to create remote tunnels and execute commands on the Apple TV without requiring physical access.

## Prerequisites

Before beginning the pairing process, ensure you have:

- An Apple TV device
- A development/client machine with this project installed
- Both devices connected to the same local network
- Network connectivity between both devices (no firewall blocking)
- Node.js and npm installed on your development machine
- This project's dependencies installed (`npm install`)

## Quick Start: Basic Pairing Steps

### Step 1: Ensure Same Network Connection

**Why this matters:** The Apple TV pairing protocol uses mDNS (multicast DNS) and Bonjour for device discovery. Both devices must be on the same local network segment to discover and communicate with each other.

**Instructions:**
1. On your Apple TV, navigate to **Settings → Network**
2. Note the network name (SSID) your Apple TV is connected to
3. On your development machine, verify you're connected to the same Wi-Fi network
4. Ensure both devices have valid IP addresses in the same subnet
5. Test network connectivity by pinging the Apple TV's IP address (if known)

### Step 2: Enable Discovery Mode on Apple TV

**Why this matters:** The Apple TV must be in pairing mode to accept incoming pairing requests. This is a security feature that prevents unauthorized devices from connecting to your Apple TV.

**Instructions:**
1. On your Apple TV, use the remote to navigate to **Settings**
2. Select **Remotes and Devices**
3. Select **Remote App and Devices**
4. The Apple TV will now enter discovery mode

![Discovery Mode Screenshot](../assets/images/discovery_mode.png)

**What happens:** When in discovery mode, the Apple TV broadcasts its availability via Bonjour/mDNS services on the network. The device advertises specific service types that allow pairing clients to discover it.

**Important notes:**
- The Apple TV will remain in discovery mode for a limited time
- You'll see a list of devices trying to connect

### Step 3: Run the Pairing Command

**Why this matters:** This command initiates the pairing protocol client on your development machine, which will discover the Apple TV, establish a connection, and begin the cryptographic handshake process.

**Instructions:**

From your project's root directory in the terminal, execute:

```bash
npm run pair-appletv
```

**What this command does:**
- Starts the device discovery service using Bonjour/mDNS
- Searches for Apple TV devices on the local network
- Lists available Apple TV devices found
- Prompts you to select a device
- Initiates the pairing protocol with the selected device
- Prepares to receive and verify the pairing PIN

**Expected output:**
```
Discovering Apple TV devices...
Found devices:
  1. Living Room Apple TV (192.168.1.100)
  2. Bedroom Apple TV (192.168.1.101)

Select device to pair: 1
Initiating pairing with Living Room Apple TV...
Waiting for PIN code...
Enter the 4-digit PIN displayed on your Apple TV:
```

![Device Selection Screenshot](../assets/images/device_selection.png)

### Step 4: Enter the Pairing PIN

**Why this matters:** The PIN verification is a critical security step that ensures you are physically present at the Apple TV and have authorized the pairing. This prevents unauthorized remote pairing attempts.

**Instructions:**

1. Look at your Apple TV screen - a 4-digit PIN code will be displayed prominently
2. The PIN is randomly generated for each pairing attempt
3. Type the PIN exactly as shown into your terminal when prompted
4. Press Enter to submit the PIN

![PIN Entry Screenshot 1](../assets/images/pin_display.png)
![PIN Entry Screenshot 2](../assets/images/pin_entry.png)

**What happens during PIN verification:**
- Your client sends the PIN to the Apple TV
- The Apple TV verifies the PIN matches what it displayed
- If correct, the Apple TV proceeds with the cryptographic key exchange
- Both devices establish a secure, encrypted session
- The pairing protocol exchanges public keys and generates shared secrets

**Security notes:**
- Each PIN is single-use and expires after a short time
- If you enter the wrong PIN, the pairing attempt will be rejected
- You'll need to restart the process if the PIN expires or fails
- The PIN ensures that only someone with physical access can pair

### Step 5: Verify Pairing Success

**Why this matters:** Successful pairing generates a pair record containing the cryptographic credentials needed for future secure communications with the Apple TV.

**What to look for:**

After PIN verification succeeds, you should see:

```bash
PIN verified successfully!
Completing pairing handshake...
Exchanging encryption keys...
Pairing completed successfully!
Pair record saved to: /path/to/strongbox/item
```

![Strongbox Record Save Screenshot](../assets/images/strongbox_record_save.png)

**Secure Credential Storage:**

The pairing credentials are now stored securely using **Appium Strongbox**, which provides OS-level credential protection:

- **macOS:** Credentials are stored in the system Keychain
- **Linux:** Credentials are stored using Secret Service API (libsecret)
- **Windows:** Credentials are stored in Windows Credential Manager

The strongbox item is named `appletv_pairing_<device_id>` and contains:
- **Device identifier:** Unique ID for the paired Apple TV
- **Public/private key pairs:** For establishing encrypted sessions
- **Device metadata:** Name, IP address, and other identifying information
- **Pairing credentials:** Shared secrets for authentication

**File format:** The pair record is stored as an XML plist format within the secure credential store.

**Security considerations:**
- Credentials are protected by your operating system's credential management system
- Access requires OS-level authentication (e.g., user login, keychain password)
- Credentials are encrypted at rest using OS-provided encryption
- No sensitive data is stored in plain text files
- Each pairing is unique to a specific device combination
- If you need to revoke access, delete the strongbox item or unpair and re-pair the device

**What you can do now:**

With a successful pairing, you can:
- Establish remote tunnel connections to the Apple TV
- Execute commands and automation scripts
- Access Apple TV services remotely over the network
- Perform testing and debugging without physical access

## Advanced: CLI Options for Automation

The pairing script supports command-line options for automated workflows and CI/CD pipelines:

### Available Options

```bash
# Interactive mode (default) - discover and select device
npm run pair-appletv

# Pair with a specific device by name
npm run pair-appletv -- --device "Living Room"

# Pair with a specific device by identifier
npm run pair-appletv -- --device "AA:BB:CC:DD:EE:FF"

# Pair with first discovered device (by index)
npm run pair-appletv -- --device 0

# Show help
npm run pair-appletv -- --help
```

**Note:** The `--` before the flags is required to pass arguments through npm to the script.

### Usage Examples

**Example 1: Pair with device by name**
```bash
npm run pair-appletv -- --device "Living Room"
```

**Example 2: Pair with first discovered device (useful for single-device setups)**
```bash
npm run pair-appletv -- --device 0
```

**Example 3: Pair with device by identifier**
```bash
npm run pair-appletv -- --device "AA:BB:CC:DD:EE:FF"
```

### Expected Output with CLI Options

When using the `--device` flag, the output will be more streamlined:

```
Discovering Apple TV devices...
Found device: Living Room Apple TV (192.168.1.100)
Initiating pairing with Living Room Apple TV...
Waiting for PIN code...
Enter the 4-digit PIN displayed on your Apple TV:
```

### CLI Option Notes

- Device names are case-sensitive
- If the specified device is not found, the script will exit with an error
- Using device index (0, 1, 2, etc.) is useful when you know the discovery order
- The `--help` flag displays all available options and examples

## Re-pairing

If you need to pair again (e.g., after resetting the Apple TV or changing networks):

1. Delete the existing pairing credentials from your system credential store:
   - **macOS:** Open Keychain Access and search for `appletv_pairing_<device_id>`, then delete the item
   - **Linux:** Use your system's credential management tool to remove the item
   - **Windows:** Open Credential Manager and remove the `appletv_pairing_<device_id>` credential
2. Follow all pairing steps from the beginning
3. A new pair record will be generated and stored securely

## Troubleshooting

### Issue: No Apple TV devices found

**Possible causes:**
- Devices are on different networks
- Apple TV is not in discovery mode
- Firewall blocking mDNS traffic
- Network has client isolation enabled

**Solutions:**
- Verify both devices are on the same Wi-Fi network
- Disable any VPN connections on your development machine
- Check router settings for AP isolation or client isolation
- Restart the Apple TV and try again
- Ensure the Apple TV is in discovery mode (Settings → Remotes and Devices)
- Try temporarily disabling firewall on your development machine
- Ensure your firewall isn't blocking mDNS traffic (port 5353 UDP)

### Issue: Device not found when using --device flag

**Possible causes:**
- Device name doesn't match exactly (case-sensitive)
- Device is not in discovery mode
- Device identifier is incorrect

**Solutions:**
- Run without the `--device` flag first to see available devices
- Ensure the device name matches exactly (including spaces and capitalization)
- Verify the device is in discovery mode
- Try using device index instead of name

### Issue: PIN verification fails

**Possible causes:**
- Incorrect PIN entered
- PIN expired
- Network interruption during verification

**Solutions:**
- Double-check you entered the correct PIN
- The PIN may have expired - restart from Step 2
- Ensure there's no network interruption during verification
- Try the pairing process again with a new PIN

### Issue: Pairing completes but credentials not saved

**Possible causes:**
- No access to system credential store
- Keychain/credential manager is locked
- Permission issues

**Solutions:**
- Check for error messages in the terminal output
- Verify you have access to the system credential store (Keychain on macOS, etc.)
- On macOS, ensure Keychain Access is not locked
- On Linux, ensure the Secret Service is running
- On Windows, verify Windows Credential Manager is accessible

### Issue: Cannot establish tunnel after pairing

**Possible causes:**
- Credentials missing or corrupted
- Apple TV IP address changed
- Network connectivity issues
- Firewall blocking tunnel port

**Solutions:**
- Verify the pairing credentials exist in the system credential store
- On macOS, check Keychain Access for `appletv_pairing_<device_id>` items
- Ensure the Apple TV is still on the same network
- The Apple TV's IP address may have changed - try pairing again
- Check that no firewall is blocking the tunnel port
- Try re-pairing if credentials may have been corrupted

### Issue: Network connectivity problems

**Possible causes:**
- VLANs separating devices
- Enterprise network restrictions
- Router AP isolation

**Solutions:**
- If devices are on different VLANs, they may not discover each other
- Enterprise networks with client isolation may block peer-to-peer communication
- Some routers have "AP Isolation" enabled which prevents device communication
- Test network connectivity by pinging the Apple TV's IP address

## Support

If you encounter issues not covered in this guide:
- Check the project's GitHub issues
- Ensure you're using compatible Apple TV firmware
- Verify all dependencies are correctly installed
