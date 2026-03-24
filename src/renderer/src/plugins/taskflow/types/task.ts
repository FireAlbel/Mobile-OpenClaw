// 任务状态枚举
export enum TaskStatus {
  CREATED = 'created',
  RUNNING = 'running',
  STOPPED = 'stopped',
  ERROR = 'error',
  COMPLETED = 'completed'
}

// 任务执行类型
export enum TaskExecutionType {
  MANUAL = 'manual',
  SCHEDULED = 'scheduled'
}

// 任务基本信息
export interface Task {
  id: string
  name: string
  description?: string
  flowData: any // ReactFlow数据
  status: TaskStatus
  executionType: TaskExecutionType
  schedule?: string // cron表达式
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
}

// 任务日志
export interface TaskLog {
  id: string
  taskId: string
  message: string
  level: 'info' | 'warn' | 'error'
  timestamp: number
}

// 任务执行结果
export interface TaskExecutionResult {
  taskId: string
  success: boolean
  message?: string
  data?: any
  timestamp: number
}
