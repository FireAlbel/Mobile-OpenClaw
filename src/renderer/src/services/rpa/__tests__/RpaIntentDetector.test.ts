import { describe, expect, it } from 'vitest'

import { isRpaPlanningRequest } from '../RpaIntentDetector'

describe('isRpaPlanningRequest', () => {
  it.each([
    '生成一个打开美团应用并截图验证的简单RPA流程',
    '请创建一个自动化任务，打开应用后截图',
    '帮我编排任务DSL并生成可执行流程',
    'Build an RPA workflow that opens Meituan and takes a screenshot'
  ])('detects an explicit workflow planning command: %s', (text) => {
    expect(isRpaPlanningRequest(text)).toBe(true)
  })

  it.each([
    '什么是RPA？',
    '如何设计一个RPA系统？',
    '分析一下RPA和Auto.js的区别',
    '打开美团应用',
    '帮我检查当前设备为什么没有连接'
  ])('keeps ordinary chat requests on the chat path: %s', (text) => {
    expect(isRpaPlanningRequest(text)).toBe(false)
  })
})
