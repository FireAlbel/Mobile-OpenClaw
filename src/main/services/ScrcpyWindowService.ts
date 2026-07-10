import { loggerService } from '@logger'
import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'

import { deviceService } from './DeviceService'

const logger = loggerService.withContext('ScrcpyWindowService')
const execFileAsync = promisify(execFile)

export interface ScrcpyWindowInfo {
  deviceId: string
  hwnd: string
  title: string
  width: number
  height: number
  x: number
  y: number
}

export interface ScrcpyWindowCapture extends ScrcpyWindowInfo {
  mime: 'image/png'
  imageBase64: string
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''")
}

async function runPowerShellJson<T>(script: string): Promise<T> {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    }
  )

  if (stderr.trim()) {
    logger.warn('PowerShell stderr while handling scrcpy window', { stderr: stderr.trim() })
  }

  const text = stdout.trim()
  if (!text) {
    throw new Error('PowerShell returned empty output')
  }

  return JSON.parse(text) as T
}

class ScrcpyWindowService {
  async getWindowInfo(deviceId: string): Promise<ScrcpyWindowInfo> {
    if (os.platform() !== 'win32') {
      throw new Error('Scrcpy window binding is currently implemented for Windows only')
    }

    const windowTitle = deviceService.getScrcpyWindowTitle(deviceId)
    if (!windowTitle) {
      throw new Error('Scrcpy is not running for this device')
    }

    const title = escapePowerShellSingleQuotedString(windowTitle)
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32ScrcpyWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
$targetTitle = '${title}'
$found = [IntPtr]::Zero
[Win32ScrcpyWindow]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [Win32ScrcpyWindow]::IsWindowVisible($hWnd)) { return $true }
  $buffer = New-Object System.Text.StringBuilder 1024
  [void][Win32ScrcpyWindow]::GetWindowText($hWnd, $buffer, $buffer.Capacity)
  if ($buffer.ToString() -eq $targetTitle) {
    $script:found = $hWnd
    return $false
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($found -eq [IntPtr]::Zero) {
  throw "Scrcpy window not found: $targetTitle"
}

$rect = New-Object Win32ScrcpyWindow+RECT
if (-not [Win32ScrcpyWindow]::GetClientRect($found, [ref]$rect)) {
  throw "Failed to read client rect"
}
$point = New-Object Win32ScrcpyWindow+POINT
$point.X = 0
$point.Y = 0
[void][Win32ScrcpyWindow]::ClientToScreen($found, [ref]$point)
$result = [PSCustomObject]@{
  deviceId = '${escapePowerShellSingleQuotedString(deviceId)}'
  hwnd = $found.ToInt64().ToString()
  title = $targetTitle
  width = [Math]::Max(0, $rect.Right - $rect.Left)
  height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  x = $point.X
  y = $point.Y
}
$result | ConvertTo-Json -Compress
`

    return runPowerShellJson<ScrcpyWindowInfo>(script)
  }

  async captureWindow(deviceId: string): Promise<ScrcpyWindowCapture> {
    const info = await this.getWindowInfo(deviceId)
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$width = ${info.width}
$height = ${info.height}
if ($width -le 0 -or $height -le 0) {
  throw "Invalid scrcpy window size: $width x $height"
}
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen(${info.x}, ${info.y}, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $base64 = [Convert]::ToBase64String($stream.ToArray())
  $result = [PSCustomObject]@{
    deviceId = '${escapePowerShellSingleQuotedString(deviceId)}'
    hwnd = '${escapePowerShellSingleQuotedString(info.hwnd)}'
    title = '${escapePowerShellSingleQuotedString(info.title)}'
    width = $width
    height = $height
    x = ${info.x}
    y = ${info.y}
    mime = 'image/png'
    imageBase64 = $base64
  }
  $result | ConvertTo-Json -Compress
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $stream.Dispose()
}
`

    return runPowerShellJson<ScrcpyWindowCapture>(script)
  }
}

export const scrcpyWindowService = new ScrcpyWindowService()
