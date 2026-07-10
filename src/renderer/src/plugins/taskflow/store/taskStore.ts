import taskFlowGraph from '../services/langgraphService'
import type { Task, TaskLog } from '../types/task'
import { TaskExecutionType, TaskStatus } from '../types/task'

class TaskStore {
  private tasks: Map<string, Task> = new Map()
  private logs: Map<string, TaskLog[]> = new Map()
  private storageKey = 'taskflow_tasks'
  private logsKey = 'taskflow_logs'
  private schedules: Map<string, NodeJS.Timeout> = new Map()

  constructor() {
    this.loadFromStorage()
  }

  // 初始化
  init() {
    console.log('TaskStore initialized')
  }

  // 从本地存储加载任务
  private loadFromStorage() {
    try {
      const storedTasks = localStorage.getItem(this.storageKey)
      if (storedTasks) {
        const tasksArray: Task[] = JSON.parse(storedTasks)
        tasksArray.forEach((task) => {
          this.tasks.set(task.id, task)
        })
      }

      const storedLogs = localStorage.getItem(this.logsKey)
      if (storedLogs) {
        const logsArray: TaskLog[] = JSON.parse(storedLogs)
        logsArray.forEach((log) => {
          if (!this.logs.has(log.taskId)) {
            this.logs.set(log.taskId, [])
          }
          this.logs.get(log.taskId)!.push(log)
        })
      }

      const logsCount = storedLogs ? JSON.parse(storedLogs).length : 0
      console.log(`从本地存储加载了 ${this.tasks.size} 个任务和 ${logsCount} 条日志`)
    } catch (error) {
      console.error('从本地存储加载任务失败:', error)
    }
  }

  // 保存到本地存储
  private saveToStorage() {
    try {
      const tasksArray = Array.from(this.tasks.values())
      localStorage.setItem(this.storageKey, JSON.stringify(tasksArray))

      const logsArray = Array.from(this.logs.values()).flat()
      localStorage.setItem(this.logsKey, JSON.stringify(logsArray))

      console.log(`保存了 ${tasksArray.length} 个任务和 ${logsArray.length} 条日志到本地存储`)
    } catch (error) {
      console.error('保存任务到本地存储失败:', error)
    }
  }

  // 创建任务
  createTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task {
    const newTask: Task = {
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    this.tasks.set(newTask.id, newTask)
    this.saveToStorage()

    this.addLog(newTask.id, `创建任务: ${newTask.name}`, 'info')

    return newTask
  }

  // 获取任务
  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  // 获取所有任务
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values())
  }

  // 更新任务
  updateTask(updatedTask: Task): Task {
    const existingTask = this.tasks.get(updatedTask.id)
    if (!existingTask) {
      throw new Error(`任务不存在: ${updatedTask.id}`)
    }

    const task: Task = {
      ...existingTask,
      ...updatedTask,
      updatedAt: Date.now()
    }

    this.tasks.set(task.id, task)
    this.saveToStorage()

    this.addLog(task.id, `更新任务: ${task.name}`, 'info')

    return task
  }

  // 删除任务
  deleteTask(id: string): boolean {
    const existed = this.tasks.delete(id)
    if (existed) {
      // 停止定时任务
      this.stopScheduledTask(id)

      // 删除相关日志
      this.logs.delete(id)

      this.saveToStorage()
      this.addLog(id, `删除任务: ${id}`, 'info')
    }
    return existed
  }

  // 运行任务
  async runTask(id: string): Promise<any> {
    const task = this.tasks.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }

    // 更新任务状态
    task.status = TaskStatus.RUNNING
    task.lastRunAt = Date.now()
    this.saveToStorage()

    this.addLog(id, `开始执行任务: ${task.name}`, 'info')

    try {
      // 构建并运行LangGraph工作流
      const result = await taskFlowGraph.runFlow(task.flowData, {
        taskId: id,
        taskName: task.name
      })

      // 更新任务状态
      task.status = TaskStatus.COMPLETED
      this.saveToStorage()

      this.addLog(id, `任务执行完成: ${task.name}`, 'info')

      return result
    } catch (error) {
      // 更新任务状态
      task.status = TaskStatus.ERROR
      this.saveToStorage()

      this.addLog(id, `任务执行失败: ${task.name} - ${error}`, 'error')

      throw error
    }
  }

  // 停止任务
  stopTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) {
      return false
    }

    // 更新任务状态
    task.status = TaskStatus.STOPPED
    this.saveToStorage()

    this.addLog(id, `停止任务: ${task.name}`, 'info')

    return true
  }

  // 添加日志
  addLog(taskId: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
    if (!this.logs.has(taskId)) {
      this.logs.set(taskId, [])
    }

    const log: TaskLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      taskId,
      message,
      level,
      timestamp: Date.now()
    }

    this.logs.get(taskId)!.push(log)
    this.saveToStorage()
  }

  // 获取任务日志
  getLogs(taskId: string): TaskLog[] {
    return this.logs.get(taskId) || []
  }

  // 获取所有日志
  getAllLogs(): TaskLog[] {
    return Array.from(this.logs.values()).flat()
  }

  // 设置定时任务
  scheduleTask(id: string, cronExpression: string) {
    // 停止现有定时任务
    this.stopScheduledTask(id)

    // 解析cron表达式并设置定时任务
    // 这里简化处理，实际应该使用cron-parser库
    const interval = this.parseCronExpression(cronExpression)
    if (!interval) {
      throw new Error(`无效的cron表达式: ${cronExpression}`)
    }

    const task = this.tasks.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }

    // 设置定时器
    const timer = setInterval(async () => {
      try {
        await this.runTask(id)
      } catch (error) {
        console.error(`定时任务执行失败: ${id}`, error)
      }
    }, interval)

    this.schedules.set(id, timer)

    // 更新任务
    task.executionType = TaskExecutionType.SCHEDULED
    task.schedule = cronExpression
    this.saveToStorage()

    this.addLog(id, `设置定时任务: ${cronExpression}`, 'info')
  }

  // 停止定时任务
  stopScheduledTask(id: string): boolean {
    const timer = this.schedules.get(id)
    if (timer) {
      clearInterval(timer)
      this.schedules.delete(id)

      const task = this.tasks.get(id)
      if (task) {
        task.executionType = TaskExecutionType.MANUAL
        task.schedule = undefined
        this.saveToStorage()
      }

      this.addLog(id, '停止定时任务', 'info')
      return true
    }
    return false
  }

  // 解析cron表达式（简化版）
  private parseCronExpression(cronExpression: string): number | null {
    // 这里实现一个简单的cron表达式解析器
    // 实际应用中应该使用专业的cron解析库

    // 支持以下格式：
    // * * * * * - 每分钟
    // 0 * * * * - 每小时
    // 0 0 * * * - 每天
    // 0 0 * * 1 - 每周一
    // 0 0 1 * * - 每月1日

    const parts = cronExpression.split(' ')
    if (parts.length !== 5) {
      return null
    }

    // 简化处理：只支持一些基本的cron表达式
    if (cronExpression === '* * * * *') {
      return 60 * 1000 // 每分钟
    } else if (cronExpression === '0 * * * *') {
      return 60 * 60 * 1000 // 每小时
    } else if (cronExpression === '0 0 * * *') {
      return 24 * 60 * 60 * 1000 // 每天
    } else if (cronExpression === '0 0 * * 1') {
      return 7 * 24 * 60 * 60 * 1000 // 每周
    } else if (cronExpression === '0 0 1 * *') {
      return 30 * 24 * 60 * 60 * 1000 // 每月
    }

    // 默认每分钟
    return 60 * 1000
  }
}

// 创建单例实例
const taskStore = new TaskStore()

export default taskStore
