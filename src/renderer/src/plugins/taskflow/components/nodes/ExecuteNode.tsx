import React, { useState } from 'react'
import { Handle, Position } from 'reactflow'
import { CodeOutlined, CloseOutlined } from '@ant-design/icons'
import { Modal, Form, Input, InputNumber, Button } from 'antd'

const ExecuteNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [config, setConfig] = useState(
    data.config || {
      script: '',
      timeout: 30
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
          border: '2px solid #fa8c16',
          borderRadius: 5,
          background: '#fff7e6',
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
        <Handle type="target" position={Position.Top} style={{ background: '#fa8c16' }} />
        <CodeOutlined style={{ color: '#fa8c16', marginRight: 5 }} />
        <div>{data.label || '执行脚本'}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 5 }}>{config.script ? '已配置脚本' : '未配置脚本'}</div>
        <Handle type="source" position={Position.Bottom} style={{ background: '#fa8c16' }} />

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
        title="配置执行节点"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        onOk={() => {
          const form = document.getElementById(`execute-form-${id}`) as HTMLFormElement
          if (form) {
            const formData = new FormData(form)
            saveConfig({
              script: formData.get('script') as string,
              timeout: parseInt(formData.get('timeout') as string)
            })
          }
        }}
        width={600}>
        <form id={`execute-form-${id}`}>
          <Form layout="vertical">
            <Form.Item label="Python脚本" name="script">
              <Input.TextArea
                name="script"
                defaultValue={config.script}
                placeholder="输入Python uiautomator2脚本"
                rows={10}
              />
            </Form.Item>
            <Form.Item label="超时时间(秒)" name="timeout">
              <InputNumber name="timeout" defaultValue={config.timeout} min={1} max={300} style={{ width: '100%' }} />
            </Form.Item>
          </Form>
        </form>
      </Modal>
    </>
  )
}

export default ExecuteNode
