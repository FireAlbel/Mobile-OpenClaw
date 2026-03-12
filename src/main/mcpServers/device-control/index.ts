import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Server as MCServer } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { app } from 'electron'

import { DeviceController } from './controller'
import { toolDefinitions, toolHandlers } from './tools'

export class DeviceControlServer {
  public server: Server
  private controller = new DeviceController()

  constructor() {
    const server = new MCServer(
      {
        name: '@cherry/device-control',
        version: '1.0.0'
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions
      }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      const handler = toolHandlers[name]
      if (!handler) {
        throw new Error('Tool not found')
      }
      return handler(this.controller, args)
    })

    app.on('before-quit', () => {
      void this.controller.cleanup()
    })

    this.server = server
  }
}

export default DeviceControlServer
