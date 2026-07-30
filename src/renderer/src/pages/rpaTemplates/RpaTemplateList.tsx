import { loggerService } from '@logger'
import RpaExecutionConfirmModal from '@renderer/pages/device/RpaExecutionConfirmModal'
import RpaExecutionProgressModal from '@renderer/pages/device/RpaExecutionProgressModal'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import type { RpaExecutionTargetSelection } from '@renderer/services/rpa/RpaExecutionTarget'
import { rpaSafetyPolicyEngine } from '@renderer/services/rpa/RpaSafetyPolicyEngine'
import { rpaTaskFlowScheduleRepository } from '@renderer/services/rpa/RpaTaskFlowScheduleRepository'
import {
  getTemplateAppPackage,
  getTemplateTask,
  inferTemplateRisk,
  type RpaTemplateRecord,
  rpaTemplateRepository
} from '@renderer/services/rpa/RpaTemplateRepository'
import type { RpaTask, RpaTaskRiskSummary } from '@renderer/services/rpa/RpaTypes'
import type { RpaTaskFlowSchedule } from '@shared/types/RpaTaskFlowSchedule'
import { Button, Empty, Input, message, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { CalendarClock, Copy, Download, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import RpaTaskFlowScheduleModal from './RpaTaskFlowScheduleModal'

const logger = loggerService.withContext('RpaTemplateList')

const RpaTemplateList: FC = () => {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<RpaTemplateRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [execution, setExecution] = useState<{ template: RpaTemplateRecord; task: RpaTask; risk: RpaTaskRiskSummary }>()
  const [runId, setRunId] = useState<string>()
  const [schedules, setSchedules] = useState<RpaTaskFlowSchedule[]>([])
  const [scheduleTaskFlow, setScheduleTaskFlow] = useState<RpaTemplateRecord>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      await rpaBatchRunner.initialize()
      const [records, taskFlowSchedules] = await Promise.all([
        rpaTemplateRepository.getAll(),
        rpaTaskFlowScheduleRepository.getAll()
      ])
      setTemplates(records)
      setSchedules(taskFlowSchedules)
    } catch (error) {
      logger.error('Failed to load RPA templates', { error })
      message.error('加载 RPA 任务流失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => {
    const runs = rpaBatchRunner.getRuns()
    return templates
      .filter((template) =>
        `${template.name} ${template.goal} ${template.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())
      )
      .map((template) => {
        const task = getTemplateTask(template)
        const related = runs.filter(
          (run) => run.task.metadata?.templateId === template.id || (task && run.task.id === task.id)
        )
        const completed = related.filter((run) => run.status === 'completed').length
        return {
          ...template,
          schedule: schedules.find((schedule) => schedule.taskFlowId === template.id),
          appPackage: getTemplateAppPackage(template),
          stepCount: task?.steps.length ?? 0,
          risk: inferTemplateRisk(template),
          lastStatus: related[0]?.status,
          successRate: related.length ? Math.round((completed / related.length) * 100) : undefined
        }
      })
  }, [schedules, search, templates])

  const requestExecution = (template: RpaTemplateRecord) => {
    const task = getTemplateTask(template)
    if (!task || template.status !== 'executable') {
      message.error('该任务流尚未通过 DSL 校验，不能执行')
      return
    }
    setExecution({
      template,
      task,
      risk: rpaSafetyPolicyEngine.analyzeTask(task, defaultRpaModuleRegistry.listMetadata())
    })
  }

  const execute = async (selection: RpaExecutionTargetSelection) => {
    if (!execution) return
    const task = {
      ...execution.task,
      deviceIds: selection.deviceIds,
      metadata: {
        ...execution.task.metadata,
        templateId: execution.template.id,
        templateVersion: execution.template.version
      }
    }
    const approval = execution.risk.highRiskTargets.length
      ? rpaSafetyPolicyEngine.createApproval(task, execution.risk.highRiskTargets, selection.deviceIds)
      : undefined
    const run = await rpaBatchRunner.start({ task, targetSelection: selection, safetyApproval: approval })
    setExecution(undefined)
    setRunId(run.id)
  }

  const duplicate = async (id: string) => {
    try {
      await rpaTemplateRepository.duplicate(id)
      message.success('任务流副本已创建')
      await load()
    } catch (error) {
      logger.error('Failed to duplicate RPA template', { error, templateId: id })
      message.error('复制任务流失败')
    }
  }

  const exportTemplate = async (template: RpaTemplateRecord) => {
    try {
      await window.api.file.save(`${safeFileName(template.name)}.json`, JSON.stringify(template.dsl, null, 2))
      message.success('DSL 已导出')
    } catch (error) {
      logger.error('Failed to export RPA template', { error, templateId: template.id })
      message.error('导出 DSL 失败')
    }
  }

  const remove = async (id: string) => {
    await rpaTaskFlowScheduleRepository.removeByTaskFlowId(id)
    await rpaTemplateRepository.remove(id)
    await load()
  }

  const triggerScheduledFlowNow = async (schedule: RpaTaskFlowSchedule) => {
    try {
      await rpaTaskFlowScheduleRepository.triggerNow(schedule.id)
      message.success('任务流已提交执行')
      await load()
    } catch (error) {
      logger.error('Failed to trigger RPA task flow schedule', { error, scheduleId: schedule.id })
      message.error(error instanceof Error ? error.message : '任务流触发失败')
    }
  }

  const columns = [
    {
      title: '任务流',
      key: 'name',
      width: 350,
      render: (_: unknown, record: (typeof rows)[number]) => (
        <NameCell>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis>
            {record.goal}
          </Typography.Text>
          <Space size={[4, 4]} wrap>
            <Tag>v{record.version}</Tag>
            <Tag color={record.status === 'executable' ? 'success' : record.status === 'draft' ? 'warning' : 'default'}>
              {record.status === 'executable' ? '可执行' : '草稿'}
            </Tag>
            {record.tags.slice(0, 3).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
        </NameCell>
      )
    },
    { title: '应用', dataIndex: 'appPackage', width: 170, render: (value?: string) => value || '-' },
    { title: '步骤', dataIndex: 'stepCount', width: 70 },
    {
      title: '风险',
      dataIndex: 'risk',
      width: 80,
      render: (risk: string) => (
        <Tag color={risk === 'high' ? 'error' : risk === 'medium' ? 'warning' : 'success'}>{risk}</Tag>
      )
    },
    {
      title: '运行效果',
      key: 'runs',
      width: 130,
      render: (_: unknown, record: (typeof rows)[number]) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{record.lastStatus ?? '尚未运行'}</Typography.Text>
          <Typography.Text type="secondary">
            成功率 {record.successRate === undefined ? '-' : `${record.successRate}%`}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (value: number) => new Date(value).toLocaleString()
    },
    {
      title: '定时',
      key: 'schedule',
      width: 165,
      render: (_: unknown, record: (typeof rows)[number]) =>
        record.schedule ? (
          <Space direction="vertical" size={0}>
            <Tag color={record.schedule.enabled ? 'success' : 'default'}>
              {record.schedule.enabled ? '已启用' : '未启用'}
            </Tag>
            <Typography.Text type="secondary">
              {record.schedule.nextRunAt ? new Date(record.schedule.nextRunAt).toLocaleString() : '无下次执行'}
            </Typography.Text>
          </Space>
        ) : (
          '-'
        )
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_: unknown, record: (typeof rows)[number]) => (
        <Space size={2}>
          <Tooltip title="确认并执行">
            <Button
              type="text"
              aria-label="确认并执行"
              icon={<Play size={16} />}
              disabled={record.status !== 'executable'}
              onClick={() => requestExecution(record)}
            />
          </Tooltip>
          <Tooltip title="定时配置">
            <Button
              type="text"
              aria-label="定时配置"
              icon={<CalendarClock size={16} />}
              onClick={() => setScheduleTaskFlow(record)}
            />
          </Tooltip>
          {record.schedule && (
            <Tooltip title="按定时配置立即执行">
              <Button
                type="text"
                aria-label="立即触发"
                icon={<Zap size={16} />}
                onClick={() => void triggerScheduledFlowNow(record.schedule!)}
              />
            </Tooltip>
          )}
          <Tooltip title="编辑">
            <Button
              type="text"
              aria-label="编辑任务流"
              icon={<Pencil size={16} />}
              onClick={() => navigate(`/rpa-workflows/edit/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title="复制">
            <Button
              type="text"
              aria-label="复制任务流"
              icon={<Copy size={16} />}
              onClick={() => void duplicate(record.id)}
            />
          </Tooltip>
          <Tooltip title="导出">
            <Button
              type="text"
              aria-label="导出 DSL"
              icon={<Download size={16} />}
              onClick={() => void exportTemplate(record)}
            />
          </Tooltip>
          <Popconfirm title="删除该任务流？运行记录不会被删除。" onConfirm={() => void remove(record.id)}>
            <Button type="text" danger aria-label="删除任务流" icon={<Trash2 size={16} />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Root>
      <Toolbar>
        <Space>
          <Input.Search
            allowClear
            placeholder="搜索名称、目标或标签"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="primary" icon={<Plus size={16} />} onClick={() => navigate('/rpa-workflows/create')}>
            新建任务流
          </Button>
        </Space>
      </Toolbar>
      {loading || rows.length ? (
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 1170 }}
        />
      ) : (
        <Empty description="暂无 RPA 任务流" />
      )}
      {execution && (
        <RpaExecutionConfirmModal
          open
          task={execution.task}
          riskSummary={execution.risk}
          onCancel={() => setExecution(undefined)}
          onExecute={execute}
        />
      )}
      <RpaExecutionProgressModal runId={runId} open={Boolean(runId)} onClose={() => setRunId(undefined)} />
      {scheduleTaskFlow && (
        <RpaTaskFlowScheduleModal
          open
          taskFlow={scheduleTaskFlow}
          onClose={() => setScheduleTaskFlow(undefined)}
          onSaved={() => void load()}
        />
      )}
    </Root>
  )
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100) || 'rpa-template'
}

const Root = styled.div`
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  overflow: hidden;

  .ant-table-wrapper {
    width: 100%;
    min-width: 0;
  }
`
const Toolbar = styled.div`
  display: flex; align-items: center; justify-content: flex-end; gap: 16px; flex-wrap: wrap;
  .ant-typography { margin: 0; }
  .ant-input-search { width: min(240px, 55vw); }
`
const NameCell = styled.div`display: flex; min-width: 0; max-width: 380px; flex-direction: column; gap: 4px;`

export default RpaTemplateList
