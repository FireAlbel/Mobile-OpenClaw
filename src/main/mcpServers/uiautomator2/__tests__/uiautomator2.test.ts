import { describe, expect, it } from 'vitest'

import UiAutomator2Server from '../index'

describe('UiAutomator2 MCP Server', () => {
  it('should create server instance', () => {
    const server = new UiAutomator2Server()
    expect(server).toBeInstanceOf(UiAutomator2Server)
  })

  it('should have server property', () => {
    const server = new UiAutomator2Server()
    expect(server.server).toBeDefined()
  })

  it('should have helper methods', () => {
    const server = new UiAutomator2Server()
    const serverInstance = server as any

    expect(typeof serverInstance.getRandomOffset).toBe('function')
    expect(typeof serverInstance.buildSelectorString).toBe('function')
    expect(typeof serverInstance.getFirstDeviceId).toBe('function')
  })
})
