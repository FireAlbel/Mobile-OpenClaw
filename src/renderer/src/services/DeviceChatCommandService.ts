import { loggerService } from '@logger'

import { deviceCoordinateService } from './DeviceCoordinateService'
import { deviceServiceProxy } from './DeviceServiceProxy'
import { deviceVisionActionService } from './DeviceVisionActionService'

const logger = loggerService.withContext('DeviceChatCommandService')

const DEVICE_COMMAND_PREFIX = /^(?:@?设备|@?手机|@?device)\s*[：:，,\s]*/i

type OnlineDevice = Awaited<ReturnType<typeof deviceServiceProxy.scanDevices>>[number]

function downloadScreenshot(deviceId: string, imageBase64: string) {
  const link = document.createElement('a')
  link.href = `data:image/png;base64,${imageBase64}`
  link.download = `device-${deviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

function splitTargetAndInstruction(instruction: string, onlineDevices: OnlineDevice[]) {
  const normalizedInstruction = instruction.trim()

  for (const device of onlineDevices) {
    const candidates = [device.id, device.name].filter(Boolean)
    for (const candidate of candidates) {
      if (normalizedInstruction === candidate) {
        return { deviceId: device.id, instruction: '' }
      }

      if (normalizedInstruction.startsWith(`${candidate} `)) {
        return {
          deviceId: device.id,
          instruction: normalizedInstruction.slice(candidate.length).trim()
        }
      }
    }
  }

  return { deviceId: undefined, instruction: normalizedInstruction }
}

async function resolveDeviceCommand(instruction: string) {
  const devices = await deviceServiceProxy.scanDevices()
  const onlineDevices = devices.filter((device) => device.status === 'online')

  if (onlineDevices.length === 0) {
    throw new Error('未找到在线设备，请先连接手机并开启 USB 调试。')
  }

  const target = splitTargetAndInstruction(instruction, onlineDevices)
  if (target.deviceId) {
    return target
  }

  if (onlineDevices.length > 1) {
    throw new Error(`检测到多台在线设备，请在指令中明确设备 ID：${onlineDevices.map((device) => device.id).join(', ')}`)
  }

  return {
    deviceId: onlineDevices[0].id,
    instruction: target.instruction
  }
}

function stripCommandPrefix(text: string) {
  return text.trim().replace(DEVICE_COMMAND_PREFIX, '').trim()
}

function isDeviceCommand(text: string) {
  return DEVICE_COMMAND_PREFIX.test(text.trim())
}

async function ensureScrcpyWindow(deviceId: string) {
  try {
    await deviceServiceProxy.getScrcpyWindow(deviceId)
  } catch {
    await deviceServiceProxy.startScrcpy(deviceId)
  }
}

function getCoordinateTokens(instruction: string): string[] {
  return instruction.match(/-?\d+(?:\.\d+)?%?/g) ?? []
}

function getPackageNameFromInstruction(instruction: string): string | null {
  const match = instruction.match(/[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+/)
  return match?.[0] ?? null
}

async function parsePointFromInstruction(deviceId: string, instruction: string) {
  const [x, y] = getCoordinateTokens(instruction)
  if (!x || !y) {
    throw new Error('请提供坐标，例如：设备 双击 500 1000，或设备 长按 50% 80%。')
  }

  const screen = await deviceServiceProxy.getScreenSize(deviceId)
  const point = deviceCoordinateService.parsePoint(x, y, screen)
  if (!point) {
    throw new Error('坐标格式错误，请使用数字或百分比，例如 500 1000 或 50% 80%。')
  }

  return point
}

async function parseRectActionFromInstruction(deviceId: string, instruction: string) {
  const [x1, y1, x2, y2] = getCoordinateTokens(instruction)
  if (!x1 || !y1 || !x2 || !y2) {
    throw new Error('请提供起止坐标，例如：设备 拖拽 100 1200 600 500。')
  }

  const screen = await deviceServiceProxy.getScreenSize(deviceId)
  const action = deviceCoordinateService.parseRectAction(x1, y1, x2, y2, screen)
  if (!action) {
    throw new Error('坐标格式错误，请使用数字或百分比，例如 10% 80% 90% 20%。')
  }

  return action
}

class DeviceChatCommandService {
  isDeviceCommand(text: string) {
    return isDeviceCommand(text)
  }

  async run(text: string): Promise<string> {
    const commandText = stripCommandPrefix(text)
    const { deviceId, instruction } = await resolveDeviceCommand(commandText)
    if (!instruction) {
      throw new Error('请输入设备指令，例如：设备 截图、设备 返回、设备 <设备ID> 向上滑动。')
    }
    logger.info('Running device chat command', { deviceId, instruction })

    if (/截图|截屏|screenshot/i.test(instruction)) {
      const screenshot = await deviceServiceProxy.getScreenshot(deviceId)
      downloadScreenshot(deviceId, screenshot.imageBase64)
      return `已完成设备截图并下载：${deviceId}`
    }

    if (/返回|back/i.test(instruction)) {
      await deviceServiceProxy.sendKeyEvent(deviceId, 4)
      return `已对设备 ${deviceId} 执行返回。`
    }

    if (/主页|home/i.test(instruction)) {
      await deviceServiceProxy.sendKeyEvent(deviceId, 3)
      return `已对设备 ${deviceId} 执行主页。`
    }

    if (/菜单|menu/i.test(instruction)) {
      await deviceServiceProxy.sendKeyEvent(deviceId, 82)
      return `已对设备 ${deviceId} 执行菜单。`
    }

    if (/电源|power/i.test(instruction)) {
      await deviceServiceProxy.sendKeyEvent(deviceId, 26)
      return `已对设备 ${deviceId} 执行电源键。`
    }

    if (/当前|前台|foreground/i.test(instruction) && /(应用|app|activity|包名|package)/i.test(instruction)) {
      const app = await deviceServiceProxy.getForegroundApp(deviceId)
      return `设备 ${deviceId} 当前前台应用：${app.packageName}${app.activity ? `/${app.activity}` : ''}`
    }

    if (/启动|打开|start|launch/i.test(instruction) && /(应用|app|package|包名|[a-zA-Z]\w*\.)/i.test(instruction)) {
      const packageName = getPackageNameFromInstruction(instruction)
      if (!packageName) {
        throw new Error('请提供要启动的 Android 包名，例如：设备 启动应用 com.tencent.mm。')
      }
      await deviceServiceProxy.startApp(deviceId, packageName)
      return `已对设备 ${deviceId} 启动应用 ${packageName}。`
    }

    if (
      /停止|关闭|stop|force\s*stop/i.test(instruction) &&
      /(应用|app|package|包名|[a-zA-Z]\w*\.)/i.test(instruction)
    ) {
      const packageName = getPackageNameFromInstruction(instruction)
      if (!packageName) {
        throw new Error('请提供要停止的 Android 包名，例如：设备 停止应用 com.tencent.mm。')
      }
      await deviceServiceProxy.stopApp(deviceId, packageName)
      return `已对设备 ${deviceId} 停止应用 ${packageName}。`
    }

    if (/重启|restart/i.test(instruction) && /(应用|app|package|包名|[a-zA-Z]\w*\.)/i.test(instruction)) {
      const packageName = getPackageNameFromInstruction(instruction)
      if (!packageName) {
        throw new Error('请提供要重启的 Android 包名，例如：设备 重启应用 com.tencent.mm。')
      }
      await deviceServiceProxy.restartApp(deviceId, packageName)
      return `已对设备 ${deviceId} 重启应用 ${packageName}。`
    }

    if (/权限|permission/i.test(instruction)) {
      const action = /拒绝|deny/i.test(instruction)
        ? 'deny'
        : /仅.*次|only\s*this\s*time/i.test(instruction)
          ? 'allow_once'
          : 'allow'
      const handled = await deviceServiceProxy.handlePermissionDialog(deviceId, action)
      return handled ? `已处理设备 ${deviceId} 的权限弹窗。` : `未在设备 ${deviceId} 上找到匹配的权限弹窗按钮。`
    }

    if (/双击|double\s*tap/i.test(instruction)) {
      const point = await parsePointFromInstruction(deviceId, instruction)
      const [, , interval] = getCoordinateTokens(instruction)
      await deviceServiceProxy.sendDoubleTap(deviceId, point.x, point.y, interval ? Number(interval) : 120)
      return `已对设备 ${deviceId} 执行双击：(${point.x}, ${point.y})。`
    }

    if (/长按|long\s*press/i.test(instruction)) {
      const point = await parsePointFromInstruction(deviceId, instruction)
      const [, , duration] = getCoordinateTokens(instruction)
      await deviceServiceProxy.sendLongPress(deviceId, point.x, point.y, duration ? Number(duration) : 800)
      return `已对设备 ${deviceId} 执行长按：(${point.x}, ${point.y})。`
    }

    if (/拖拽|drag/i.test(instruction)) {
      const action = await parseRectActionFromInstruction(deviceId, instruction)
      const [, , , , duration] = getCoordinateTokens(instruction)
      await deviceServiceProxy.sendDrag(
        deviceId,
        action.x1,
        action.y1,
        action.x2,
        action.y2,
        duration ? Number(duration) : 700
      )
      return `已对设备 ${deviceId} 执行拖拽：(${action.x1}, ${action.y1}) -> (${action.x2}, ${action.y2})。`
    }

    if (/向上|上滑|swipe\s*up/i.test(instruction)) {
      const screen = await deviceServiceProxy.getScreenSize(deviceId)
      const x = Math.round(screen.width / 2)
      await deviceServiceProxy.sendSwipe(
        deviceId,
        x,
        Math.round(screen.height * 0.82),
        x,
        Math.round(screen.height * 0.32),
        500
      )
      return `已对设备 ${deviceId} 执行向上滑动。`
    }

    if (/向下|下滑|swipe\s*down/i.test(instruction)) {
      const screen = await deviceServiceProxy.getScreenSize(deviceId)
      const x = Math.round(screen.width / 2)
      await deviceServiceProxy.sendSwipe(
        deviceId,
        x,
        Math.round(screen.height * 0.32),
        x,
        Math.round(screen.height * 0.82),
        500
      )
      return `已对设备 ${deviceId} 执行向下滑动。`
    }

    await ensureScrcpyWindow(deviceId)
    const result = await deviceVisionActionService.runVisionAction(deviceId, instruction)
    return `已执行智能设备指令：${result.action.action} -> ${JSON.stringify(result.deviceAction)}`
  }
}

export const deviceChatCommandService = new DeviceChatCommandService()
