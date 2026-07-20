import type { RpaBatchRunRecord } from './RpaRunStorage'
import type {
  RpaCorrectionAction,
  RpaRunEventPhase,
  RpaRunStepEvent,
  RpaSafetyDecision,
  RpaVerificationResult
} from './RpaTypes'

export type RpaReplayArtifactStatus = 'available' | 'missing'

export interface RpaReplayFrame {
  id: string
  deviceId: string
  deviceRunId: string
  stepId: string
  stepName: string
  status: RpaRunStepEvent['status']
  phase?: RpaRunStepEvent['phase']
  attempt: number
  recoveryRound?: number
  timestamp: number
  message: string
  action?: RpaCorrectionAction
  verification?: RpaVerificationResult
  safety?: RpaSafetyDecision
  modelOutput?: string
  observation?: unknown
  screenshot?: RpaReplayScreenshot
  artifactStatus: RpaReplayArtifactStatus
}

export interface RpaReplayScreenshot {
  imageBase64: string
  mime: string
  source?: string
  capturedAt?: number
}

export interface RpaReplay {
  run: RpaBatchRunRecord
  frames: RpaReplayFrame[]
  phases: string[]
  missingArtifactCount: number
}

export class RpaReplayService {
  load(run: RpaBatchRunRecord): RpaReplay {
    const frames = run.deviceRuns
      .flatMap((deviceRun) =>
        deviceRun.events.map((event, index) => {
          const screenshot = findScreenshot(event.data)
          return {
            id: `${deviceRun.id}:${event.timestamp}:${index}`,
            deviceId: deviceRun.deviceId,
            deviceRunId: deviceRun.id,
            stepId: event.stepId,
            stepName: event.stepName,
            status: event.status,
            phase: event.phase ?? findEventPhase(event.data),
            attempt: event.attempt,
            recoveryRound: event.recoveryRound,
            timestamp: event.timestamp,
            message: event.message,
            action: event.action,
            verification: event.verification,
            safety: event.safety,
            modelOutput: findModelOutput(event.data),
            observation: findObjectProperty(event.data, 'observation'),
            screenshot,
            artifactStatus: screenshot ? ('available' as const) : ('missing' as const)
          }
        })
      )
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))

    return {
      run,
      frames,
      phases: [...new Set(frames.flatMap((frame) => (frame.phase ? [frame.phase] : [])))],
      missingArtifactCount: frames.filter((frame) => frame.artifactStatus === 'missing').length
    }
  }
}

function findScreenshot(value: unknown): RpaReplayScreenshot | undefined {
  if (!value || typeof value !== 'object') return undefined

  if ('imageBase64' in value && typeof value.imageBase64 === 'string' && value.imageBase64) {
    return {
      imageBase64: value.imageBase64,
      mime: 'mime' in value && typeof value.mime === 'string' ? value.mime : 'image/png',
      source: 'source' in value && typeof value.source === 'string' ? value.source : undefined,
      capturedAt: 'capturedAt' in value && typeof value.capturedAt === 'number' ? value.capturedAt : undefined
    }
  }

  for (const nested of Object.values(value)) {
    const screenshot = findScreenshot(nested)
    if (screenshot) return screenshot
  }
  return undefined
}

function findModelOutput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  for (const key of ['rawResponse', 'repairResponse', 'takeoverResponse', 'modelOutput']) {
    if (key in value && typeof value[key] === 'string') return value[key]
  }
  for (const nested of Object.values(value)) {
    const output = findModelOutput(nested)
    if (output) return output
  }
  return undefined
}

function findObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (key in value) return value[key]
  for (const nested of Object.values(value)) {
    const result = findObjectProperty(nested, key)
    if (result !== undefined) return result
  }
  return undefined
}

function findStringProperty(value: unknown, key: string): string | undefined {
  const result = findObjectProperty(value, key)
  return typeof result === 'string' ? result : undefined
}

const EVENT_PHASES = new Set<RpaRunEventPhase>([
  'original_step',
  'original_failure',
  'correction_observation',
  'correction_decision',
  'temporary_action',
  'temporary_step',
  'correction_verification',
  'correction_terminal',
  'safety_policy'
])

function findEventPhase(value: unknown): RpaRunEventPhase | undefined {
  const phase = findStringProperty(value, 'phase')
  return phase && EVENT_PHASES.has(phase as RpaRunEventPhase) ? (phase as RpaRunEventPhase) : undefined
}

export const rpaReplayService = new RpaReplayService()
