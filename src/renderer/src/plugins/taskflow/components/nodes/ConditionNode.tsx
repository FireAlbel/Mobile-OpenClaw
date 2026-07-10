import { CloseOutlined, ForkOutlined } from '@ant-design/icons'
import { Button, Form, Input, Modal, Select } from 'antd'
import React, { useState } from 'react'
import { Handle, Position } from 'reactflow'

const ConditionNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [config, setConfig] = useState(
    data.config || {
      conditions: []
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
          border: '2px solid #13c2c2',
          borderRadius: 5,
          background: '#e6fffb',
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
        <Handle type="target" position={Position.Top} style={{ background: '#13c2c2' }} />
        <ForkOutlined style={{ color: '#13c2c2', marginRight: 5 }} />
        <div>{data.label || '条件判断'}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 5 }}>
          {config.conditions?.length ? `${config.conditions.length}个条件` : '未配置条件'}
        </div>
        <Handle type="source" position={Position.Bottom} id="true" style={{ background: '#52c41a', left: '25%' }} />
        <Handle type="source" position={Position.Bottom} id="false" style={{ background: '#f5222d', left: '75%' }} />

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
        title="配置条件判断节点"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        onOk={() => {
          // 这里简化处理，实际应该更复杂
          const form = document.getElementById(`condition-form-${id}`) as HTMLFormElement
          if (form) {
            const formData = new FormData(form)
            saveConfig({
              conditions: [
                {
                  field: formData.get('field') as string,
                  operator: formData.get('operator') as string,
                  value: formData.get('value') as string,
                  targetNodeId: 'true'
                }
              ]
            })
          }
        }}
        width={600}>
        <form id={`condition-form-${id}`}>
          <Form layout="vertical">
            <Form.Item label="字段" name="field">
              <Input name="field" placeholder="要判断的字段名" />
            </Form.Item>
            <Form.Item label="操作符" name="operator">
              <Select defaultValue="equals">
                <Select.Option value="equals">等于</Select.Option>
                <Select.Option value="contains">包含</Select.Option>
                <Select.Option value="greater">大于</Select.Option>
                <Select.Option value="less">小于</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item label="值" name="value">
              <Input name="value" placeholder="比较的值" />
            </Form.Item>
          </Form>
        </form>
      </Modal>
    </>
  )
}

export default ConditionNode
