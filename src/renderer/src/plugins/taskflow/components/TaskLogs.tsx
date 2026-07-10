import { ReloadOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { Button, DatePicker, Input, Space, Table, Tag } from 'antd'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import taskStore from '../store/taskStore'
import type { TaskLog } from '../types/task'

const { Search } = Input
const { RangePicker } = DatePicker
const logger = loggerService.withContext('TaskLogs')

const TaskLogs: React.FC = () => {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [filteredLogs, setFilteredLogs] = useState<TaskLog[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [dateRange, setDateRange] = useState<any>(null)

  // 加载日志
  useEffect(() => {
    loadLogs()
  }, [])

  // 过滤日志
  useEffect(() => {
    let filtered = logs

    // 按搜索文本过滤
    if (searchText) {
      filtered = filtered.filter((log) => log.message.toLowerCase().includes(searchText.toLowerCase()))
    }

    // 按日期范围过滤
    if (dateRange && dateRange.length === 2) {
      const startTime = dateRange[0].valueOf()
      const endTime = dateRange[1].valueOf()
      filtered = filtered.filter((log) => log.timestamp >= startTime && log.timestamp <= endTime)
    }

    setFilteredLogs(filtered)
  }, [logs, searchText, dateRange])

  const loadLogs = () => {
    setLoading(true)
    try {
      const allLogs = taskStore.getAllLogs()
      // 按时间倒序排列
      const sortedLogs = allLogs.sort((a, b) => b.timestamp - a.timestamp)
      setLogs(sortedLogs)
    } catch (error) {
      logger.error('Failed to load task logs', { error })
    } finally {
      setLoading(false)
    }
  }

  // 获取日志级别颜色
  const getLevelColor = (level: 'info' | 'warn' | 'error') => {
    switch (level) {
      case 'info':
        return 'blue'
      case 'warn':
        return 'orange'
      case 'error':
        return 'red'
      default:
        return 'default'
    }
  }

  // 获取日志级别文本
  const getLevelText = (level: 'info' | 'warn' | 'error') => {
    switch (level) {
      case 'info':
        return t('taskflow.logs.info')
      case 'warn':
        return t('taskflow.logs.warn')
      case 'error':
        return t('taskflow.logs.error')
      default:
        return level
    }
  }

  const columns = [
    {
      title: '时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 180,
      render: (timestamp: number) => new Date(timestamp).toLocaleString()
    },
    {
      title: '级别',
      dataIndex: 'level',
      key: 'level',
      width: 80,
      render: (level: 'info' | 'warn' | 'error') => <Tag color={getLevelColor(level)}>{getLevelText(level)}</Tag>
    },
    {
      title: '消息',
      dataIndex: 'message',
      key: 'message'
    }
  ]

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Space>
          <Button type="primary" icon={<ReloadOutlined />} onClick={loadLogs} loading={loading}>
            {t('taskflow.logs.refresh')}
          </Button>
        </Space>

        <Space>
          <RangePicker
            value={dateRange}
            onChange={(dates) => setDateRange(dates)}
            placeholder={[t('taskflow.logs.startTime'), t('taskflow.logs.endTime')]}
          />
          <Search
            placeholder={t('taskflow.logs.search')}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 300 }}
          />
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={filteredLogs}
        rowKey="id"
        loading={loading}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
          showTotal: (total) => `${t('common.total')} ${total} ${t('common.records')}`
        }}
      />
    </div>
  )
}

export default TaskLogs
