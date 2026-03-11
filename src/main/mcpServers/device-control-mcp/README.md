# Device Control MCP Server

An MCP (Model Context Protocol) server for controlling Android devices using ADB and Scrcpy.

## Features

- **Device Discovery**: List all connected Android devices
- **Screen Mirroring**: Start/stop Scrcpy screen mirroring
- **Input Control**: Send touch, swipe, and text input events
- **App Management**: Install/uninstall APKs
- **Device Info**: Get detailed device information
- **Screenshot**: Capture device screenshots
- **Raw ADB**: Execute custom ADB commands

## Tools

### `list_devices`
List all connected Android devices.

**Input**: None
**Output**: Array of device objects with id, name, status, and properties

### `get_device_info`
Get detailed information about a specific device.

**Input**:
- `deviceId` (string): Device serial number

**Output**: Device information including model, brand, Android version, etc.

### `start_scrcpy`
Start screen mirroring for a device using scrcpy.

**Input**:
- `deviceId` (string): Device serial number
- `options` (object): Optional scrcpy configuration

**Options**:
- `maxSize`: Maximum video size (e.g., 1024)
- `bitRate`: Video bit rate in bits per second (e.g., 8000000)
- `maxFps`: Maximum frames per second (e.g., 30)
- `stayAwake`: Keep device awake
- `turnScreenOff`: Turn screen off when mirroring starts
- `noAudio`: Disable audio forwarding
- `showTouches`: Show touch events
- `windowTitle`: Set window title
- `alwaysOnTop`: Keep window always on top
- `fullscreen`: Start in fullscreen mode
- `borderless`: Start in borderless mode
- `windowX`, `windowY`: Window position
- `windowWidth`, `windowHeight`: Window dimensions

### `stop_scrcpy`
Stop screen mirroring for a device.

**Input**:
- `deviceId` (string): Device serial number

### `send_tap`
Send tap event to device.

**Input**:
- `deviceId` (string): Device serial number
- `x` (number): X coordinate
- `y` (number): Y coordinate

### `send_swipe`
Send swipe event to device.

**Input**:
- `deviceId` (string): Device serial number
- `startX`, `startY`: Start coordinates
- `endX`, `endY`: End coordinates
- `duration` (number): Swipe duration in milliseconds (default: 500)

### `send_text`
Send text input to device.

**Input**:
- `deviceId` (string): Device serial number
- `text` (string): Text to input

### `send_key_event`
Send key event to device.

**Input**:
- `deviceId` (string): Device serial number
- `keyCode` (number): Android key code

### `install_apk`
Install APK on device.

**Input**:
- `deviceId` (string): Device serial number
- `apkPath` (string): Path to APK file

### `uninstall_package`
Uninstall package from device.

**Input**:
- `deviceId` (string): Device serial number
- `packageName` (string): Package name to uninstall

### `execute_adb_command`
Execute raw ADB command.

**Input**:
- `deviceId` (string): Device serial number
- `command` (string): ADB command to execute

### `get_screenshot`
Take screenshot of device.

**Input**:
- `deviceId` (string): Device serial number

**Output**: Base64 encoded PNG screenshot

### `get_device_property`
Get device property.

**Input**:
- `deviceId` (string): Device serial number
- `property` (string): Property name (e.g., ro.product.model)

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
node index.js
```

Or with TypeScript:

```bash
npm run dev
```

## Requirements

- Android Debug Bridge (ADB)
- Scrcpy
- Node.js 18+
- Connected Android devices with USB debugging enabled

## License

GPL-3.0
