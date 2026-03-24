// 节点类型枚举
export enum NodeType {
  START = 'start',
  LISTEN_MESSAGE = 'listenMessage',
  LLM = 'llm',
  EXECUTE = 'execute',
  CONDITION = 'condition',
  SEND_MESSAGE = 'sendMessage',
  END = 'end'
}

// 基础节点数据
export interface BaseNodeData {
  label: string
  description?: string
  config?: any
}

// 开始节点
export interface StartNodeData extends BaseNodeData {
  type: NodeType.START
}

// 监听消息节点
export interface ListenMessageNodeData extends BaseNodeData {
  type: NodeType.LISTEN_MESSAGE
  config: {
    contact?: string
    group?: string
    keywords?: string[]
  }
}

// LLM节点
export interface LLMNodeData extends BaseNodeData {
  type: NodeType.LLM
  config: {
    prompt?: string
    model?: string
    temperature?: number
  }
}

// 执行节点
export interface ExecuteNodeData extends BaseNodeData {
  type: NodeType.EXECUTE
  config: {
    script?: string
    timeout?: number
  }
}

// 条件判断节点
export interface ConditionNodeData extends BaseNodeData {
  type: NodeType.CONDITION
  config: {
    conditions?: Array<{
      field: string
      operator: 'equals' | 'contains' | 'greater' | 'less'
      value: any
      targetNodeId: string
    }>
  }
}

// 发送消息节点
export interface SendMessageNodeData extends BaseNodeData {
  type: NodeType.SEND_MESSAGE
  config: {
    contact?: string
    group?: string
    message?: string
    useTemplate?: boolean
  }
}

// 结束节点
export interface EndNodeData extends BaseNodeData {
  type: NodeType.END
  result?: any
}

// 节点数据联合类型
export type NodeData =
  | StartNodeData
  | ListenMessageNodeData
  | LLMNodeData
  | ExecuteNodeData
  | ConditionNodeData
  | SendMessageNodeData
  | EndNodeData

// ReactFlow节点类型
export interface FlowNode {
  id: string
  type: NodeType
  position: { x: number; y: number }
  data: NodeData
}

// ReactFlow边类型
export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  type?: string
}

// 流程数据
export interface FlowData {
  nodes: FlowNode[]
  edges: FlowEdge[]
}
