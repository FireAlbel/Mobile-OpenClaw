import React, { useState } from 'react'
import { Handle, Position } from 'reactflow'
import { RobotOutlined, CloseOutlined } from '@ant-design/icons'
import { Modal, Form, Input, Slider, Select, Button } from 'antd'

const LLMNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [config, setConfig] = useState(
    data.config || {
      prompt: '',
      model: 'gpt-3.5-turbo',
      temperature: 0.7
    }
  )

  const saveConfig = (values: any) => {
    setConfig(values)
    setIsModalVisible(false)
    // 更新节点数据
    if (data) {
      data.config = values
    }
  }

  const handleDelete = () => {
    if (data.onDelete) {
      data.onDelete(id)
    }
  }

  return (
    <>
      <div
        style={{
          padding: 10,
          border: '2px solid #722ed1',
          borderRadius: 5,
          background: '#f9f0ff',
          minWidth: 150,
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
            border: 'none',
            zIndex: 10
          }}
        />
        <Handle type="target" position={Position.Top} style={{ background: '#722ed1' }} />
        <RobotOutlined style={{ color: '#722ed1', marginRight: 5 }} />
        <div>{data.label || 'LLM理解'}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 5 }}>{config.model || '未配置模型'}</div>
        <Handle type="source" position={Position.Bottom} style={{ background: '#722ed1' }} />

        <div
          style={{
            position: 'absolute',
            top: -10,
            right: -10,
            cursor: 'pointer',
            background: '#fff',
            borderRadius: '50%',
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 5px rgba(0,0,0,0.2)'
          }}
          onClick={() => setIsModalVisible(true)}>
          ⚙️
        </div>
      </div>

      <Modal
        title="配置LLM节点"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        onOk={() => {
          const form = document.getElementById(`llm-form-${id}`) as HTMLFormElement
          if (form) {
            const formData = new FormData(form)
            saveConfig({
              prompt: formData.get('prompt') as string,
              model: formData.get('model') as string,
              temperature: parseFloat(formData.get('temperature') as string)
            })
          }
        }}
        width={600}>
        <form id={`llm-form-${id}`}>
          <Form layout="vertical">
            <Form.Item label="提示词" name="prompt">
              <Input.TextArea name="prompt" defaultValue={config.prompt} placeholder="输入提示词模板" rows={5} />
            </Form.Item>
            <Form.Item label="模型" name="model">
              <Select defaultValue={config.model}>
                <Select.Option value="gpt-3.5-turbo">GPT-3.5 Turbo</Select.Option>
                <Select.Option value="gpt-4">GPT-4</Select.Option>
                <Select.Option value="deepseek-chat">DeepSeek Chat</Select.Option>
                <Select.Option value="doubao-pro-32k">豆包 Pro 32K</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item label="温度" name="temperature">
              <Slider
                defaultValue={config.temperature}
                min={0}
                max={1}
                step={0.1}
                marks={{ 0: '保守', 0.5: '平衡', 1: '创造' }}
              />
            </Form.Item>
          </Form>
        </form>
      </Modal>
    </>
  )
}

export default LLMNode
