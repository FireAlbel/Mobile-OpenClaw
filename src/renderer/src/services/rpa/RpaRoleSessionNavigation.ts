import type { Topic } from '@renderer/types'

import type { RpaAppRole } from './RpaAppRole'
import type { RpaRolePrompt } from './RpaRolePrompt'

const NEW_SESSION_PARAM = 'newRpaSession'
const ROLE_ID_PARAM = 'rpaRoleId'

export interface RpaRoleSessionRequest {
  roleId: string
  requestId: string
}

export function createRpaRoleSessionPath(roleId: string, requestId: string = crypto.randomUUID()): string {
  const params = new URLSearchParams({
    [ROLE_ID_PARAM]: roleId.trim(),
    [NEW_SESSION_PARAM]: requestId
  })
  return `/?${params.toString()}`
}

export function readRpaRoleSessionRequest(hash: string): RpaRoleSessionRequest | undefined {
  const query = hash.split('?')[1]
  const params = new URLSearchParams(query ?? '')
  const roleId = params.get(ROLE_ID_PARAM)?.trim()
  const requestId = params.get(NEW_SESSION_PARAM)?.trim()
  return roleId && requestId ? { roleId, requestId } : undefined
}

export function consumeRpaRoleSessionRequest(hash: string): string {
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query ?? '')
  params.delete(NEW_SESSION_PARAM)
  params.delete(ROLE_ID_PARAM)
  const nextQuery = params.toString()
  return `${path}${nextQuery ? `?${nextQuery}` : ''}`
}

export function bindTopicToRpaRole(topic: Topic, role: RpaAppRole, prompts: RpaRolePrompt[]): Topic {
  const systemPrompt = prompts
    .filter((prompt) => prompt.roleId === role.id && prompt.status === 'enabled' && prompt.kind === 'system')
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .map((prompt) => prompt.content.trim())
    .filter(Boolean)
    .join('\n\n')

  return {
    ...topic,
    name: role.name,
    prompt: systemPrompt || role.description || '',
    isNameManuallyEdited: true,
    rpaRoleId: role.id,
    rpaRoleVersion: role.version,
    rpaRoleName: role.name,
    rpaRoleDescription: role.description
  }
}
