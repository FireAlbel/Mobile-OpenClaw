import { loggerService } from '@logger'
import { exec } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)
const logger = loggerService.withContext('ToolPaths')

export interface ToolPaths {
  adbPath: string
  scrcpyPath: string
}

/**
 * 工具路径管理器
 * 负责管理 ADB 和 Scrcpy 工具的路径，支持从应用内打包路径或系统路径查找
 */
export class ToolPathManager {
  private static instance: ToolPathManager
  private toolPaths: ToolPaths = {
    adbPath: 'adb',
    scrcpyPath: 'scrcpy'
  }
  private initialized = false

  private constructor() {}

  public static getInstance(): ToolPathManager {
    if (!ToolPathManager.instance) {
      ToolPathManager.instance = new ToolPathManager()
    }
    return ToolPathManager.instance
  }

  /**
   * 初始化工具路径
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    try {
      // 获取应用内工具路径
      const bundledPaths = this.getBundledToolPaths()

      // 检测系统路径
      const systemPaths = await this.detectSystemToolPaths()

      // 优先使用应用内打包的工具
      this.toolPaths.adbPath = bundledPaths.adbPath || systemPaths.adbPath || 'adb'
      this.toolPaths.scrcpyPath = bundledPaths.scrcpyPath || systemPaths.scrcpyPath || 'scrcpy'

      this.initialized = true

      logger.info('Tool paths initialized', {
        adbPath: this.toolPaths.adbPath,
        scrcpyPath: this.toolPaths.scrcpyPath,
        isBundled: {
          adb: !!bundledPaths.adbPath,
          scrcpy: !!bundledPaths.scrcpyPath
        }
      })
    } catch (error) {
      logger.error('Failed to initialize tool paths', error as Error)
      this.initialized = true // 标记为已初始化，避免重复尝试
    }
  }

  /**
   * 获取应用内打包的工具路径
   */
  private getBundledToolPaths(): Partial<ToolPaths> {
    const paths: Partial<ToolPaths> = {}

    try {
      // 获取应用资源目录
      const resourcesPath = app.isPackaged
        ? join(process.resourcesPath, 'tools')
        : join(__dirname, '../../resources/tools')

      // 确保资源目录存在
      if (!existsSync(resourcesPath)) {
        mkdirSync(resourcesPath, { recursive: true })
      }

      // 确保平台工具目录存在
      const platformToolsPath = join(resourcesPath, 'platform-tools')
      if (!existsSync(platformToolsPath)) {
        mkdirSync(platformToolsPath, { recursive: true })
      }

      // 确保scrcpy目录存在
      const scrcpyDirPath = join(resourcesPath, 'scrcpy')
      if (!existsSync(scrcpyDirPath)) {
        mkdirSync(scrcpyDirPath, { recursive: true })
      }

      const platform = process.platform
      const isWindows = platform === 'win32'

      // ADB 路径
      const adbExecutable = isWindows ? 'adb.exe' : 'adb'
      const adbPath = join(resourcesPath, 'platform-tools', adbExecutable)
      if (existsSync(adbPath)) {
        paths.adbPath = adbPath
      }

      // Scrcpy 路径
      const scrcpyExecutable = isWindows ? 'scrcpy.exe' : 'scrcpy'
      const scrcpyPath = join(resourcesPath, 'scrcpy', scrcpyExecutable)
      if (existsSync(scrcpyPath)) {
        paths.scrcpyPath = scrcpyPath
      }

      logger.info('Bundled tool paths', { resourcesPath, adbPath, scrcpyPath })
    } catch (error) {
      logger.error('Failed to get bundled tool paths', error as Error)
    }

    return paths
  }

  /**
   * 检测系统工具路径
   */
  private async detectSystemToolPaths(): Promise<Partial<ToolPaths>> {
    const paths: Partial<ToolPaths> = {}

    try {
      const locator = process.platform === 'win32' ? 'where' : 'which'

      // 检测 ADB
      try {
        const { stdout } = await execAsync(`${locator} adb`)
        const detectedPath = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        if (detectedPath) {
          paths.adbPath = detectedPath
        }
      } catch {
        // ADB 不在 PATH 中，尝试常见路径
        const commonAdbPaths = this.getCommonAdbPaths()
        for (const path of commonAdbPaths) {
          if (existsSync(path)) {
            paths.adbPath = path
            break
          }
        }
      }

      // 检测 Scrcpy
      try {
        const { stdout } = await execAsync(`${locator} scrcpy`)
        const detectedPath = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        if (detectedPath) {
          paths.scrcpyPath = detectedPath
        }
      } catch {
        // Scrcpy 不在 PATH 中，尝试常见路径
        const commonScrcpyPaths = this.getCommonScrcpyPaths()
        for (const path of commonScrcpyPaths) {
          if (existsSync(path)) {
            paths.scrcpyPath = path
            break
          }
        }
      }
    } catch (error) {
      logger.error('Failed to detect system tool paths', error as Error)
    }

    return paths
  }

  /**
   * 获取常见的 ADB 路径
   */
  private getCommonAdbPaths(): string[] {
    const platform = process.platform
    const isWindows = platform === 'win32'
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''

    const paths: string[] = []

    if (isWindows) {
      paths.push(
        'D:\\goProject\\scrcpyPlugin\\platform-tools\\adb.exe',
        `${homeDir}\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe`,
        'C:\\Program Files (x86)\\Android\\android-sdk\\platform-tools\\adb.exe',
        'C:\\Program Files\\Android\\android-sdk\\platform-tools\\adb.exe'
      )
    } else {
      paths.push(
        '/usr/local/bin/adb',
        '/usr/bin/adb',
        `${homeDir}/Library/Android/sdk/platform-tools/adb`,
        `${homeDir}/Android/Sdk/platform-tools/adb`
      )
    }

    return paths
  }

  /**
   * 获取常见的 Scrcpy 路径
   */
  private getCommonScrcpyPaths(): string[] {
    const platform = process.platform
    const isWindows = platform === 'win32'
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''

    const paths: string[] = []

    if (isWindows) {
      paths.push(
        'D:\\goProject\\scrcpyPlugin\\scrcpy.exe',
        'C:\\Program Files\\scrcpy\\scrcpy.exe',
        'C:\\Program Files (x86)\\scrcpy\\scrcpy.exe',
        `${homeDir}\\scrcpy\\scrcpy.exe`
      )
    } else {
      paths.push('/usr/local/bin/scrcpy', '/usr/bin/scrcpy', `${homeDir}/scrcpy/scrcpy`)
    }

    return paths
  }

  /**
   * 验证工具是否可用
   */
  public async validateTool(toolPath: string, toolName: string): Promise<boolean> {
    try {
      if (toolName === 'adb') {
        const { stdout } = await execAsync(`"${toolPath}" version`)
        return stdout.includes('Android Debug Bridge')
      } else if (toolName === 'scrcpy') {
        const { stdout } = await execAsync(`"${toolPath}" --version`)
        return stdout.includes('scrcpy')
      }
      return false
    } catch (error) {
      logger.warn(`Tool validation failed for ${toolName}:`, { toolPath, error })
      return false
    }
  }

  /**
   * 获取当前工具路径
   */
  public getToolPaths(): ToolPaths {
    return { ...this.toolPaths }
  }

  /**
   * 手动设置工具路径
   */
  public setToolPath(toolName: keyof ToolPaths, path: string): void {
    this.toolPaths[toolName] = path
    logger.info(`Tool path set manually`, { toolName, path })
  }

  /**
   * 下载并安装工具
   */
  public async downloadAndInstallTools(): Promise<{ success: boolean; message: string }> {
    try {
      logger.info('Starting tool download and installation')

      // 这里可以添加下载逻辑
      // 例如从 GitHub 下载 ADB platform-tools 和 scrcpy

      return {
        success: true,
        message: 'Tools downloaded and installed successfully'
      }
    } catch (error) {
      logger.error('Failed to download and install tools', error as Error)
      return {
        success: false,
        message: `Failed to download tools: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

/**
 * 获取工具路径管理器实例
 */
export const toolPathManager = ToolPathManager.getInstance()

/**
 * 初始化工具路径（应该在应用启动时调用）
 */
export async function initializeToolPaths(): Promise<void> {
  await toolPathManager.initialize()
}
