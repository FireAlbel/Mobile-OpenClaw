import React from 'react'
import { Handle, Position } from 'reactflow'
import { PlayCircleOutlined, CloseOutlined } from '@ant-design/icons'
import { Button } from 'antd'

const StartNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const handleDelete = () => {
    if (data.onDelete) {
      data.onDelete(id)
    }
  }

  return (
    <div
      style={{
        padding: 10,
        border: '2px solid #52c41a',
        borderRadius: 5,
        background: '#f6ffed',
        minWidth: 120,
        textAlign: 'center',
        position: 'relative'
      }}>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        onClick={handleDelete}
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          padding: 0,
          width: 16,
          height: 16,
          fontSize: 10,
          color: '#ff4d4f',
          border: 'none'
        }}
      />
      <PlayCircleOutlined style={{ color: '#52c41a', marginRight: 5 }} />
      <div>{data.label || '开始'}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#52c41a' }} />
    </div>
  )
}

export default StartNode
