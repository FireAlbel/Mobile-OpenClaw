// IPC通信服务，用于Electron渲染进程与主进程之间的通信

export interface IPCResponse {
  success: boolean
  data?: any
  error?: string
}

export interface LLMRequest {
  prompt: string
  model?: string
  temperature?: number
  messages?: any[]
  apiKey?: string
  endpoint?: string
}

export interface LLMResponse {
  success: boolean
  content?: string
  error?: string
}

class IPCService {
  /**
   * 调用Python脚本
   * @param scriptPath 脚本路径
   * @param args 脚本参数
   * @param timeout 超时时间（毫秒）
   * @returns 执行结果
   */
  async callPythonScript(scriptPath: string, args: string[] = [], timeout: number = 60000): Promise<IPCResponse> {
    try {
      // 检查是否在Electron环境中
      if ((window as any).electronAPI && (window as any).electronAPI.callPythonScript) {
        return await (window as any).electronAPI.callPythonScript(scriptPath, args, timeout)
      } else {
        // 开发环境中模拟调用
        console.log('模拟调用Python脚本:', scriptPath, args)

        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // 返回模拟结果
        return {
          success: true,
          data: {
            message: '模拟Python脚本执行结果',
            script: scriptPath,
            args: args,
            timestamp: Date.now()
          }
        }
      }
    } catch (error) {
      console.error('调用Python脚本失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 调用LLM API
   * @param request LLM请求参数
   * @returns LLM响应
   */
  async callLLMAPI(request: LLMRequest): Promise<LLMResponse> {
    try {
      // 检查是否在Electron环境中
      if ((window as any).electronAPI && (window as any).electronAPI.callLLMAPI) {
        return await (window as any).electronAPI.callLLMAPI(request)
      } else {
        // 开发环境中模拟调用
        console.log('模拟调用LLM API:', request)

        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // 返回模拟结果
        const mockResponses = [
          "根据消息内容，我应该回复：'收到，我会尽快处理。'",
          "这是一个询问产品信息的请求，建议回复：'您好，我们的产品有以下特点...'",
          "看起来是客户投诉，请立即处理并回复：'非常抱歉给您带来不便，我们会尽快解决您的问题。'",
          "这是一条感谢消息，可以简单回复：'感谢您的支持！'"
        ]

        const randomResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)]

        return {
          success: true,
          content: randomResponse
        }
      }
    } catch (error) {
      console.error('调用LLM API失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 执行Python代码片段
   * @param code Python代码
   * @param timeout 超时时间（毫秒）
   * @returns 执行结果
   */
  async executePythonCode(code: string, timeout: number = 30000): Promise<IPCResponse> {
    try {
      // 检查是否在Electron环境中
      if ((window as any).electronAPI && (window as any).electronAPI.executePythonCode) {
        return await (window as any).electronAPI.executePythonCode(code, timeout)
      } else {
        // 开发环境中模拟执行
        console.log('模拟执行Python代码:', code.substring(0, 100) + '...')

        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 1500))

        // 返回模拟结果
        return {
          success: true,
          data: {
            message: 'Python代码执行成功',
            code: code.substring(0, 50) + '...',
            timestamp: Date.now()
          }
        }
      }
    } catch (error) {
      console.error('执行Python代码失败:', error)
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
  async checkDeviceConnection(): Promise<IPCResponse> {
    try {
      // 检查是否在Electron环境中
      if ((window as any).electronAPI && (window as any).electronAPI.checkDeviceConnection) {
        return await (window as any).electronAPI.checkDeviceConnection()
      } else {
        // 开发环境中模拟检查
        console.log('模拟检查设备连接状态')

        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 500))

        // 返回模拟结果
        return {
          success: true,
          data: {
            connected: true,
            deviceInfo: {
              serial: 'emulator-5554',
              model: 'Android SDK built for x86',
              version: '11'
            }
          }
        }
      }
    } catch (error) {
      console.error('检查设备连接状态失败:', error)
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
  async getDeviceList(): Promise<IPCResponse> {
    try {
      // 检查是否在Electron环境中
      if ((window as any).electronAPI && (window as any).electronAPI.getDeviceList) {
        return await (window as any).electronAPI.getDeviceList()
      } else {
        // 开发环境中模拟获取
        console.log('模拟获取设备列表')

        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 500))

        // 返回模拟结果
        return {
          success: true,
          data: {
            devices: [
              {
                serial: 'emulator-5554',
                model: 'Android SDK built for x86',
                version: '11',
                status: 'device'
              }
            ]
          }
        }
      }
    } catch (error) {
      console.error('获取设备列表失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

// 创建单例实例
const ipcService = new IPCService()

export default ipcService
