// 主进程服务，处理与Python脚本的交互
import { ipcMain } from 'electron'
import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

interface PythonScriptResult {
  success: boolean
  data?: any
  error?: string
  returnCode?: number | null
}

class TaskFlowService {
  private pythonProcesses: Map<string, ChildProcess> = new Map()
  private pluginPath: string

  constructor() {
    this.pluginPath = path.join(__dirname, '../src/renderer/src/plugins/taskflow')
    this.setupIPC()
  }

  /**
   * 设置IPC监听器
   */
  private setupIPC() {
    // 调用Python脚本
    ipcMain.handle(
      'call-python-script',
      async (_event, scriptPath: string, args: string[] = [], timeout: number = 60000) => {
        return await this.callPythonScript(scriptPath, args, timeout)
      }
    )

    // 执行Python代码
    ipcMain.handle('execute-python-code', async (_event, code: string, timeout: number = 30000) => {
      return await this.executePythonCode(code, timeout)
    })

    // 调用LLM API
    ipcMain.handle('call-llm-api', async (_event, request: any) => {
      return await this.callLLMAPI(request)
    })

    // 检查设备连接状态
    ipcMain.handle('check-device-connection', async () => {
      return await this.checkDeviceConnection()
    })

    // 获取设备列表
    ipcMain.handle('get-device-list', async () => {
      return await this.getDeviceList()
    })
  }

  /**
   * 调用Python脚本
   * @param scriptPath 脚本路径
   * @param args 脚本参数
   * @param timeout 超时时间（毫秒）
   * @returns 执行结果
   */
  private async callPythonScript(
    scriptPath: string,
    args: string[] = [],
    timeout: number = 60000
  ): Promise<PythonScriptResult> {
    return new Promise((resolve) => {
      try {
        // 检查脚本文件是否存在
        if (!fs.existsSync(scriptPath)) {
          resolve({
            success: false,
            error: `脚本文件不存在: ${scriptPath}`
          })
          return
        }

        // 确保Python环境可用
        const pythonExecutable = this.getPythonExecutable()
        if (!pythonExecutable) {
          resolve({
            success: false,
            error: '未找到Python可执行文件'
          })
          return
        }

        // 启动Python进程
        const processId = `python-${Date.now()}`
        const pythonProcess = spawn(pythonExecutable, [scriptPath, ...args], {
          cwd: path.dirname(scriptPath),
          env: {
            ...process.env,
            PYTHONPATH: path.join(this.pluginPath, 'python')
          }
        })

        this.pythonProcesses.set(processId, pythonProcess)

        let stdout = ''
        let stderr = ''

        // 收集标准输出
        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        // 收集错误输出
        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        // 设置超时
        const timeoutId = setTimeout(() => {
          if (this.pythonProcesses.has(processId)) {
            pythonProcess.kill('SIGTERM')
            resolve({
              success: false,
              error: `脚本执行超时 (${timeout}ms)`
            })
          }
        }, timeout)

        // 进程结束处理
        pythonProcess.on('close', (code) => {
          clearTimeout(timeoutId)
          this.pythonProcesses.delete(processId)

          try {
            // 尝试解析JSON输出
            let resultData: any = null
            if (stdout.trim()) {
              try {
                resultData = JSON.parse(stdout.trim())
              } catch {
                resultData = stdout.trim()
              }
            }

            if (code === 0) {
              resolve({
                success: true,
                data: resultData,
                returnCode: code
              })
            } else {
              resolve({
                success: false,
                error: stderr || `脚本执行失败，返回码: ${code}`,
                returnCode: code,
                data: resultData
              })
            }
          } catch (error) {
            resolve({
              success: false,
              error: `解析脚本输出失败: ${error instanceof Error ? error.message : String(error)}`
            })
          }
        })

        // 进程错误处理
        pythonProcess.on('error', (error) => {
          clearTimeout(timeoutId)
          this.pythonProcesses.delete(processId)
          resolve({
            success: false,
            error: `启动Python进程失败: ${error.message}`
          })
        })
      } catch (error) {
        resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  /**
   * 执行Python代码片段
   * @param code Python代码
   * @param timeout 超时时间（毫秒）
   * @returns 执行结果
   */
  private async executePythonCode(code: string, timeout: number = 30000): Promise<PythonScriptResult> {
    return new Promise((resolve) => {
      try {
        // 创建临时文件
        const tempDir = os.tmpdir()
        const tempFile = path.join(tempDir, `taskflow_${Date.now()}.py`)

        fs.writeFileSync(tempFile, code)

        // 执行临时文件
        this.callPythonScript(tempFile, [], timeout)
          .then((result) => {
            // 删除临时文件
            try {
              fs.unlinkSync(tempFile)
            } catch (unlinkError) {
              console.warn('删除临时文件失败:', unlinkError)
            }
            resolve(result)
          })
          .catch((error) => {
            // 删除临时文件
            try {
              fs.unlinkSync(tempFile)
            } catch (unlinkError) {
              console.warn('删除临时文件失败:', unlinkError)
            }
            resolve({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            })
          })
      } catch (error) {
        resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  /**
   * 调用LLM API
   * @param request LLM请求参数
   * @returns LLM响应
   */
  private async callLLMAPI(request: any): Promise<PythonScriptResult> {
    try {
      // 这里可以实现调用OpenAI、DeepSeek、豆包等LLM API的逻辑
      // 为了演示，我们返回一个模拟响应

      const mockResponses = [
        "根据消息内容，我应该回复：'收到，我会尽快处理。'",
        "这是一个询问产品信息的请求，建议回复：'您好，我们的产品有以下特点...'",
        "看起来是客户投诉，请立即处理并回复：'非常抱歉给您带来不便，我们会尽快解决您的问题。'",
        "这是一条感谢消息，可以简单回复：'感谢您的支持！'"
      ]

      const randomResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)]

      return {
        success: true,
        data: {
          content: randomResponse,
          model: request.model || 'gpt-3.5-turbo',
          usage: {
            prompt_tokens: 50,
            completion_tokens: 20,
            total_tokens: 70
          }
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检查设备连接状态
   * @returns 设备连接状态
   */
  private async checkDeviceConnection(): Promise<PythonScriptResult> {
    try {
      // 检查ADB设备连接
      const adbResult = await this.runADBCommand(['devices'])

      if (!adbResult.success) {
        return {
          success: false,
          error: 'ADB命令执行失败'
        }
      }

      const devices = this.parseADBDevices(adbResult.data as string)

      return {
        success: true,
        data: {
          connected: devices.length > 0,
          devices: devices
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 获取设备列表
   * @returns 设备列表
   */
  private async getDeviceList(): Promise<PythonScriptResult> {
    try {
      // 执行ADB命令获取设备列表
      const adbResult = await this.runADBCommand(['devices', '-l'])

      if (!adbResult.success) {
        return {
          success: false,
          error: 'ADB命令执行失败'
        }
      }

      const devices = this.parseADBDevices(adbResult.data as string, true)

      return {
        success: true,
        data: {
          devices: devices
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 运行ADB命令
   * @param args ADB命令参数
   * @returns 命令执行结果
   */
  private async runADBCommand(args: string[]): Promise<PythonScriptResult> {
    return new Promise((resolve) => {
      try {
        const adbProcess = spawn('adb', args)
        let stdout = ''
        let stderr = ''

        adbProcess.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        adbProcess.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        adbProcess.on('close', (code) => {
          if (code === 0) {
            resolve({
              success: true,
              data: stdout
            })
          } else {
            resolve({
              success: false,
              error: stderr || `ADB命令执行失败，返回码: ${code}`
            })
          }
        })

        adbProcess.on('error', (error) => {
          resolve({
            success: false,
            error: `启动ADB进程失败: ${error.message}`
          })
        })
      } catch (error) {
        resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  /**
   * 解析ADB设备列表
   * @param output ADB输出
   * @param detailed 是否解析详细信息
   * @returns 设备列表
   */
  private parseADBDevices(output: string, detailed: boolean = false): any[] {
    const devices: any[] = []
    const lines = output.split('\n').filter((line) => line.trim())

    // 跳过标题行
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const parts = line.split(/\s+/)
      if (parts.length >= 2) {
        const device = {
          serial: parts[0],
          status: parts[1]
        }

        if (detailed && parts.length > 2) {
          // 解析详细设备信息
          for (let j = 2; j < parts.length; j++) {
            const part = parts[j]
            if (part.includes(':')) {
              const [key, value] = part.split(':')
              device[key] = value
            }
          }
        }

        devices.push(device)
      }
    }

    return devices
  }

  /**
   * 获取Python可执行文件路径
   * @returns Python可执行文件路径
   */
  private getPythonExecutable(): string | null {
    const possiblePaths = [
      'python3',
      'python',
      // Windows路径
      'C:\\Python39\\python.exe',
      'C:\\Python38\\python.exe',
      'C:\\Python37\\python.exe',
      // macOS路径
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      // Linux路径
      '/usr/bin/python3'
    ]

    for (const pythonPath of possiblePaths) {
      try {
        const { spawnSync } = require('child_process')
        const result = spawnSync(pythonPath, ['--version'])
        if (result.status === 0) {
          return pythonPath
        }
      } catch (error) {
        // 继续尝试下一个路径
      }
    }

    return null
  }

  /**
   * 停止所有Python进程
   */
  stopAllProcesses() {
    this.pythonProcesses.forEach((process, id) => {
      try {
        process.kill('SIGTERM')
        console.log(`已停止Python进程: ${id}`)
      } catch (error) {
        console.error(`停止Python进程失败: ${id}`, error)
      }
    })
    this.pythonProcesses.clear()
  }
}

// 创建单例实例
const taskFlowService = new TaskFlowService()

export default taskFlowService
