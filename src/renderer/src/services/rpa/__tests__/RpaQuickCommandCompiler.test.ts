import { describe, expect, it } from 'vitest'

import { RpaQuickCommandCompiler } from '../RpaQuickCommandCompiler'

describe('RpaQuickCommandCompiler', () => {
  const compiler = new RpaQuickCommandCompiler()

  it.each([
    ['设备 返回', 'press_back', {}],
    ['@手机 截图', 'screenshot', {}],
    ['device tap 120 340', 'tap_absolute', { x: 120, y: 340 }],
    ['设备 等待 2 秒', 'wait', { durationMs: 2_000 }],
    ['设备 打开 com.example.app', 'launch_app', { packageName: 'com.example.app' }]
  ])('compiles %s into one auditable DSL step', (input, moduleId, params) => {
    const result = compiler.compile(input, { taskId: 'task-1' })

    expect(result?.task).toMatchObject({
      deviceIds: [],
      metadata: { quickCommand: true },
      steps: [{ moduleId, params }]
    })
  })

  it('leaves unsupported device instructions for the Planner', () => {
    expect(compiler.compile('设备 找到并点击金币', { taskId: 'task-1' })).toBeUndefined()
    expect(compiler.compile('普通聊天', { taskId: 'task-1' })).toBeUndefined()
  })
})
