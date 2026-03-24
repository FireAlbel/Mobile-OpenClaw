import React, { useState, useEffect } from 'react'
import { Table, Button, message, Popconfirm, Tag, Space, Input } from 'antd'
import { PlayCircleOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import taskStore from '../store/taskStore'
import type { Task } from '../types/task'
import { TaskStatus, TaskExecutionType } from '../types/task'

const { Search } = Input

const TaskList: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')

  // 加载任务列表
  useEffect(() => {
    loadTasks()
  }, [])

  const loadTasks = () => {
    setLoading(true)
    try {
      const allTasks = taskStore.getAllTasks()
      setTasks(allTasks)
    } catch (error) {
      message.error(t('taskflow.list.loadError'))
      console.error('加载任务失败:', error)
    } finally {
      setLoading(false)
    }
  }

  // 运行任务
  const handleRunTask = async (taskId: string) => {
    try {
      setLoading(true)
      await taskStore.runTask(taskId)
      message.success(t('taskflow.list.runSuccess'))
      loadTasks()
    } catch (error) {
      message.error(`${t('taskflow.list.runError')}: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  // 删除任务
  const handleDeleteTask = (taskId: string) => {
    try {
      taskStore.deleteTask(taskId)
      message.success(t('taskflow.list.deleteSuccess'))
      loadTasks()
    } catch (error) {
      message.error(t('taskflow.list.deleteError'))
    }
  }

  // 编辑任务
  const handleEditTask = (taskId: string) => {
    navigate(`/taskflow/edit/${taskId}`)
  }

  // 获取状态标签颜色
  const getStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.RUNNING:
        return 'processing'
      case TaskStatus.COMPLETED:
        return 'success'
      case TaskStatus.ERROR:
        return 'error'
      case TaskStatus.STOPPED:
        return 'warning'
      default:
        return 'default'
    }
  }

  // 获取状态文本
  const getStatusText = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.CREATED:
        return t('taskflow.status.created')
      case TaskStatus.RUNNING:
        return t('taskflow.status.running')
      case TaskStatus.STOPPED:
        return t('taskflow.status.stopped')
      case TaskStatus.ERROR:
        return t('taskflow.status.error')
      case TaskStatus.COMPLETED:
        return t('taskflow.status.completed')
      default:
        return status
    }
  }

  // 过滤任务
  const filteredTasks = tasks.filter(
    (task) =>
      task.name.toLowerCase().includes(searchText.toLowerCase()) ||
      (task.description && task.description.toLowerCase().includes(searchText.toLowerCase()))
  )

  const columns = [
    {
      title: t('taskflow.list.name'),
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: Task) => (
        <div>
          <div>{text}</div>
          {record.description && <div style={{ fontSize: 12, color: '#666' }}>{record.description}</div>}
        </div>
      )
    },
    {
      title: t('taskflow.list.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: TaskStatus) => <Tag color={getStatusColor(status)}>{getStatusText(status)}</Tag>
    },
    {
      title: t('taskflow.list.executionType'),
      dataIndex: 'executionType',
      key: 'executionType',
      render: (type: TaskExecutionType) => (
        <Tag color={type === TaskExecutionType.SCHEDULED ? 'blue' : 'green'}>
          {type === TaskExecutionType.SCHEDULED ? t('taskflow.executionType.scheduled') : t('taskflow.executionType.manual')}
        </Tag>
      )
    },
    {
      title: t('taskflow.list.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (timestamp: number) => new Date(timestamp).toLocaleString()
    },
    {
      title: t('taskflow.list.lastRunAt'),
      dataIndex: 'lastRunAt',
      key: 'lastRunAt',
      render: (timestamp?: number) => (timestamp ? new Date(timestamp).toLocaleString() : t('taskflow.list.neverRun'))
    },
    {
      title: t('taskflow.list.actions'),
      key: 'actions',
      render: (_: any, record: Task) => (
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => handleRunTask(record.id)}
            loading={loading && record.status === TaskStatus.RUNNING}
            disabled={record.status === TaskStatus.RUNNING}>
            {t('taskflow.list.run')}
          </Button>
          <Button icon={<EditOutlined />} onClick={() => handleEditTask(record.id)}>
            {t('taskflow.list.edit')}
          </Button>
          <Popconfirm
            title={t('taskflow.list.deleteConfirm')}
            onConfirm={() => handleDeleteTask(record.id)}
            okText={t('common.ok')}
            cancelText={t('common.cancel')}>
            <Button danger icon={<DeleteOutlined />}>
              {t('taskflow.list.delete')}
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => navigate('/taskflow/create')}
            style={{ marginRight: 8 }}>
            {t('taskflow.list.create')}
          </Button>
          <Button onClick={() => navigate('/taskflow/logs')}>{t('taskflow.list.viewLogs')}</Button>
        </div>
        <Search
          placeholder={t('taskflow.list.search')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredTasks}
        rowKey="id"
        loading={loading}
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          showTotal: (total) => `${t('common.total')} ${total} ${t('common.records')}`
        }}
      />
    </div>
  )
}

export default TaskList
