import { describe, expect, it } from 'vitest'

import {
  bindTopicToRpaRole,
  consumeRpaRoleSessionRequest,
  createRpaRoleSessionPath,
  readRpaRoleSessionRequest
} from '../RpaRoleSessionNavigation'

describe('RpaRoleSessionNavigation', () => {
  it('creates a unique new-session navigation request for a Role', () => {
    const path = createRpaRoleSessionPath('role 1', 'request-1')

    expect(path).toBe('/?rpaRoleId=role+1&newRpaSession=request-1')
    expect(readRpaRoleSessionRequest(`#${path}`)).toEqual({ roleId: 'role 1', requestId: 'request-1' })
  })

  it('removes transient Role session parameters after the Topic is bound', () => {
    expect(consumeRpaRoleSessionRequest('#/?rpaRoleId=role-1&newRpaSession=request-1')).toBe('#/')
  })

  it('binds the new Topic to the Role snapshot and system prompts', () => {
    const topic = bindTopicToRpaRole(
      {
        id: 'topic-1',
        assistantId: 'assistant-1',
        name: 'Default topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: []
      },
      {
        schemaVersion: 1,
        id: 'role-1',
        name: 'Meituan Operator',
        description: 'Operate Meituan tasks',
        appPackages: ['com.sankuai.meituan'],
        supportedAppVersions: [],
        status: 'draft',
        version: 3,
        supportingRoleIds: [],
        systemCapabilities: [],
        assetBindings: [],
        createdAt: 1,
        updatedAt: 1
      },
      [
        {
          schemaVersion: 1,
          id: 'system',
          roleId: 'role-1',
          version: '1',
          kind: 'system',
          content: 'Use the configured RPA assets.',
          priority: 10,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    )

    expect(topic).toMatchObject({
      name: 'Meituan Operator',
      prompt: 'Use the configured RPA assets.',
      rpaRoleId: 'role-1',
      rpaRoleVersion: 3,
      rpaRoleName: 'Meituan Operator',
      rpaRoleDescription: 'Operate Meituan tasks',
      isNameManuallyEdited: true
    })
  })
})
