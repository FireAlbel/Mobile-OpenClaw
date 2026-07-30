import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('legacy Taskflow removal', () => {
  it('keeps only the RPA task-flow routes and removes the legacy implementation', async () => {
    const router = await readFile(resolve(projectRoot, 'src/renderer/src/Router.tsx'), 'utf8')
    const legacyRoute = ['/', 'taskflow'].join('')

    expect(router).toContain('/rpa-workflows')
    expect(router).not.toContain(legacyRoute)
    await expect(exists(resolve(projectRoot, 'src/main/services/taskflowService.ts'))).resolves.toBe(false)
    await expect(exists(resolve(projectRoot, 'src/renderer/src/plugins/taskflow/index.ts'))).resolves.toBe(false)
    await expect(exists(resolve(projectRoot, 'src/renderer/src/plugins/taskflow/store/taskStore.ts'))).resolves.toBe(
      false
    )
  })

  it('does not expose legacy execution IPC commands', async () => {
    const sourceFiles = [
      resolve(projectRoot, 'src/main/ipc.ts'),
      resolve(projectRoot, 'src/preload/index.ts'),
      resolve(projectRoot, 'packages/shared/IpcChannel.ts')
    ]
    const source = (await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')))).join('\n')
    const legacyCommands = [
      ['call', 'python', 'script'].join('-'),
      ['execute', 'python', 'code'].join('-'),
      ['call', 'llm', 'api'].join('-')
    ]

    for (const command of legacyCommands) expect(source).not.toContain(command)
  })
})
