import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Server as MCServer } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { app } from 'electron'

import { ChatMonitorController } from './controller'
import { toolDefinitions, toolHandlers } from './tools'

/**
 * ChatMonitorServer
 *
 * MCP 服务实现思路：
 * 1) 服务层只负责协议适配（ListTools / CallTool）；
 * 2) 业务逻辑全部收敛到 ChatMonitorController；
 * 3) 工具定义与处理器拆分到 tools.ts，便于后续新增工具时保持结构清晰；
 * 4) 通过 before-quit 做资源清理，防止应用退出时残留子进程/状态。
 */
export class ChatMonitorServer {
  public server: Server
  private controller = new ChatMonitorController()

  constructor() {
    const server = new MCServer(
      {
        name: '@cherry/chat-monitor',
        version: '0.1.0'
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    )

    // MCP 标准能力：列出工具
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions
      }
    })

    // MCP 标准能力：调用工具
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      const handler = toolHandlers[name]

      if (!handler) {
        throw new Error(`Tool not found: ${name}`)
      }

      return handler(this.controller, args)
    })

    // 应用退出前清理控制器资源
    app.on('before-quit', () => {
      void this.controller.cleanup()
    })

    this.server = server
  }
}

export default ChatMonitorServer
