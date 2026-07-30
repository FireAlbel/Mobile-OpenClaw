import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaStep, RpaTask } from './RpaTypes'

const commandPrefix = /^(?:@?设备|@?手机|@?device)\s*[：:,，\s]*/i
const packagePattern = /[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+/

export interface RpaQuickCommandCompileResult {
  task: RpaTask
  instruction: string
}

export class RpaQuickCommandCompiler {
  private readonly validator = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false })

  canCompile(input: string): boolean {
    return commandPrefix.test(input.trim()) && Boolean(this.compileStep(stripPrefix(input)))
  }

  compile(input: string, options: { taskId: string; taskName?: string }): RpaQuickCommandCompileResult | undefined {
    if (!commandPrefix.test(input.trim())) return undefined
    const instruction = stripPrefix(input)
    const step = this.compileStep(instruction)
    if (!step) return undefined
    const task: RpaTask = {
      id: options.taskId,
      name: options.taskName?.trim() || instruction.slice(0, 48),
      goal: instruction,
      deviceIds: [],
      steps: [step],
      metadata: { quickCommand: true, sourceInstruction: instruction }
    }
    const validation = this.validator.validate(task)
    return validation.success && validation.task ? { task: validation.task, instruction } : undefined
  }

  private compileStep(instruction: string): RpaStep | undefined {
    if (!instruction) return undefined
    if (/^(?:返回|back)$/i.test(instruction)) return step('press_back', 'Press back')
    if (/^(?:主页|首页|home)$/i.test(instruction)) return step('press_home', 'Press home')
    if (/^(?:截图|截屏|screenshot)$/i.test(instruction)) {
      return step('screenshot', 'Capture screenshot', {}, { type: 'screenshot_exists' })
    }
    if (/^(?:点击|tap)\s+/i.test(instruction)) {
      const [x, y] = numbers(instruction)
      if (x === undefined || y === undefined) return undefined
      return step('tap_absolute', 'Tap coordinate', { x, y })
    }
    if (/^(?:等待|wait)\s+/i.test(instruction)) {
      const [duration] = numbers(instruction)
      if (duration === undefined) return undefined
      const durationMs = /秒|\bsec(?:ond)?s?\b/i.test(instruction) ? duration * 1_000 : duration
      return step('wait', 'Wait', { durationMs })
    }
    if (/^(?:启动|打开|launch|start)\s+/i.test(instruction)) {
      const packageName = instruction.match(packagePattern)?.[0]
      if (!packageName) return undefined
      return step('launch_app', 'Launch app', { packageName }, { type: 'foreground_app', packageName })
    }
    if (/^(?:重启|restart)\s+/i.test(instruction)) {
      const packageName = instruction.match(packagePattern)?.[0]
      if (!packageName) return undefined
      return step('restart_app', 'Restart app', { packageName }, { type: 'foreground_app', packageName })
    }
    return undefined
  }
}

function stripPrefix(input: string): string {
  return input.trim().replace(commandPrefix, '').trim()
}

function numbers(input: string): number[] {
  return (input.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
}

function step(
  moduleId: string,
  name: string,
  params: Record<string, unknown> = {},
  verify: RpaStep['verify'] = { type: 'module_result_success' }
): RpaStep {
  return {
    id: 'quick-command-step',
    name,
    moduleId,
    params,
    timeoutMs: 30_000,
    retry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed', 'timeout'] },
    verify,
    continueOnFailure: false
  }
}

export const rpaQuickCommandCompiler = new RpaQuickCommandCompiler()
