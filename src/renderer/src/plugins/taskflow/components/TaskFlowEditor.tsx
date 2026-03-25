import 'reactflow/dist/style.css'

import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { Button, Form, Input, message } from 'antd'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import type { Connection, Edge, Node } from 'reactflow'
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from 'reactflow'
import styled from 'styled-components'

import taskStore from '../store/taskStore'
import { NodeType } from '../types/flow'
import { TaskExecutionType, TaskStatus } from '../types/task'
import ConditionNode from './nodes/ConditionNode'
import EndNode from './nodes/EndNode'
import ExecuteNode from './nodes/ExecuteNode'
import ListenMessageNode from './nodes/ListenMessageNode'
import LLMNode from './nodes/LLMNode'
import SendMessageNode from './nodes/SendMessageNode'
import StartNode from './nodes/StartNode'

const nodeTypes = {
  [NodeType.START]: StartNode,
  [NodeType.LISTEN_MESSAGE]: ListenMessageNode,
  [NodeType.LLM]: LLMNode,
  [NodeType.EXECUTE]: ExecuteNode,
  [NodeType.CONDITION]: ConditionNode,
  [NodeType.SEND_MESSAGE]: SendMessageNode,
  [NodeType.END]: EndNode
}

const TaskFlowEditor: React.FC = () => {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [taskName, setTaskName] = useState('')
  const [taskDescription, setTaskDescription] = useState('')

  // 删除节点
  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((node) => node.id !== nodeId))
      setEdges((eds) => eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    },
    [setNodes, setEdges]
  )

  // 加载现有任务
  useEffect(() => {
    if (id) {
      const task = taskStore.getTask(id)
      if (task) {
        setTaskName(task.name)
        setTaskDescription(task.description || '')
        // 为现有节点添加删除函数
        const nodesWithDelete = (task.flowData.nodes || []).map((node: Node) => ({
          ...node,
          data: {
            ...node.data,
            onDelete: deleteNode
          }
        }))
        setNodes(nodesWithDelete)
        setEdges(task.flowData.edges || [])
        console.log('加载任务:', task)
      } else {
        console.log('未找到任务:', id)
      }
    } else {
      console.log('创建新任务')
      // 添加一个默认的开始节点用于测试
      setNodes([
        {
          id: 'start-1',
          type: NodeType.START,
          position: { x: 100, y: 100 },
          data: { label: t('taskflow.nodes.start'), onDelete: deleteNode }
        }
      ])
    }
  }, [id, deleteNode])

  // 连接节点
  const onConnect = useCallback((params: Edge | Connection) => setEdges((eds) => addEdge(params, eds)), [setEdges])

  // 添加节点
  const addNode = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: {
          label: getNodeLabel(type),
          type,
          onDelete: deleteNode
        }
      }
      setNodes((nds) => nds.concat(newNode))
    },
    [setNodes, deleteNode]
  )

  // 获取节点标签
  const getNodeLabel = (type: NodeType): string => {
    switch (type) {
      case NodeType.START:
        return t('taskflow.nodes.start')
      case NodeType.LISTEN_MESSAGE:
        return t('taskflow.nodes.listenMessage')
      case NodeType.LLM:
        return t('taskflow.nodes.llm')
      case NodeType.EXECUTE:
        return t('taskflow.nodes.execute')
      case NodeType.CONDITION:
        return t('taskflow.nodes.condition')
      case NodeType.SEND_MESSAGE:
        return t('taskflow.nodes.sendMessage')
      case NodeType.END:
        return t('taskflow.nodes.end')
      default:
        return t('taskflow.nodes.unknown')
    }
  }

  // 保存任务
  const saveTask = () => {
    if (!taskName.trim()) {
      message.error(t('taskflow.editor.taskNameRequired'))
      return
    }

    // 清理节点数据中的函数引用，避免序列化问题
    const cleanNodes = nodes.map((node) => {
      const { onDelete, ...cleanData } = node.data || {}
      return {
        ...node,
        data: cleanData
      }
    })

    const flowData = {
      nodes: cleanNodes,
      edges
    }

    const task = {
      id: id || `task-${Date.now()}`,
      name: taskName,
      description: taskDescription,
      flowData,
      status: TaskStatus.CREATED,
      executionType: TaskExecutionType.MANUAL,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    try {
      if (id) {
        taskStore.updateTask(task)
        message.success(t('taskflow.editor.updateSuccess'))
      } else {
        taskStore.createTask(task)
        message.success(t('taskflow.editor.createSuccess'))
        navigate(`/taskflow/edit/${task.id}`)
      }
    } catch (error) {
      console.error('保存任务失败:', error)
      message.error(`保存失败: ${error}`)
    }
  }

  // 运行任务
  const runTask = async () => {
    if (!id) {
      message.error(t('taskflow.editor.saveFirst'))
      return
    }

    try {
      message.info(t('taskflow.editor.startingTask'))
      await taskStore.runTask(id)
      message.success(t('taskflow.editor.runSuccess'))
    } catch (error) {
      message.error(`${t('taskflow.editor.runError')}: ${error}`)
    }
  }

  // 拖拽添加节点
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      if (!reactFlowBounds) return

      const type = event.dataTransfer.getData('application/reactflow') as NodeType
      if (!type) return

      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top
      }

      addNode(type, position)
    },
    [addNode]
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  return (
    <Container id="taskflow-editor-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>
          {id ? t('taskflow.editor.edit') : t('taskflow.editor.create')}
        </NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <ToolbarContainer>
          <div style={{ padding: 10 }}>
            <h3>{t('taskflow.editor.nodeTypes')}</h3>
            <div style={{ marginTop: 10 }}>
              {Object.values(NodeType).map((type) => (
                <div
                  key={type}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/reactflow', type)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  style={{
                    padding: '8px 12px',
                    margin: '5px 0',
                    backgroundColor: '#f0f0f0',
                    borderRadius: 4,
                    cursor: 'move'
                  }}>
                  {getNodeLabel(type)}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20 }}>
              <h3>{t('taskflow.editor.taskInfo')}</h3>
              <Form layout="vertical" style={{ marginTop: 10 }}>
                <Form.Item label={t('taskflow.editor.taskName')} required>
                  <Input
                    value={taskName}
                    onChange={(e) => setTaskName(e.target.value)}
                    placeholder={t('taskflow.editor.taskNamePlaceholder')}
                  />
                </Form.Item>
                <Form.Item label={t('taskflow.editor.taskDescription')}>
                  <Input.TextArea
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    placeholder={t('taskflow.editor.taskDescriptionPlaceholder')}
                    rows={3}
                  />
                </Form.Item>
              </Form>
            </div>
          </div>
        </ToolbarContainer>
        <EditorWrapper ref={reactFlowWrapper}>
          <ActionBar>
            <div>
              <Button type="primary" onClick={saveTask} style={{ marginRight: 8 }}>
                {t('taskflow.editor.save')}
              </Button>
              <Button onClick={runTask} disabled={!id}>
                {t('taskflow.editor.run')}
              </Button>
            </div>
            <div>
              <Button onClick={() => navigate('/taskflow')}>{t('taskflow.editor.back')}</Button>
            </div>
          </ActionBar>
          <FlowEditor>
            <div style={{ width: '100%', height: '100%', position: 'relative', border: '1px solid red' }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onDrop={onDrop}
                onDragOver={onDragOver}
                nodeTypes={nodeTypes}
                fitView
                style={{ width: '100%', height: '100%' }}>
                <Background />
                <Controls />
                <MiniMap />
              </ReactFlow>
            </div>
          </FlowEditor>
        </EditorWrapper>
      </ContentContainer>
    </Container>
  )
}

const TaskFlowEditorWrapper: React.FC = () => (
  <ReactFlowProvider>
    <TaskFlowEditor />
  </ReactFlowProvider>
)

// 标准容器样式
const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 0;
  width: 100%;
`

const ToolbarContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 200px;
  min-width: 200px;
  border-right: 1px solid var(--color-border);
  background-color: var(--color-background-soft);
  overflow-y: auto;
`

const EditorWrapper = styled.div`
  display: flex;
  position: relative;
  flex-direction: column;
  justify-content: space-between;
  width: 100%;
  flex: 1;
  max-width: 100%;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  height: 100%;
`

const ActionBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-background-soft);
`

const FlowEditor = styled.div`
  flex: 1;
  width: 100%;
  height: 100%;
  position: relative;
  min-height: 400px;
`

export default TaskFlowEditorWrapper
