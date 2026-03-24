import React, { useState } from 'react'
import { Handle, Position } from 'reactflow'
import { MessageOutlined, CloseOutlined } from '@ant-design/icons'
import { Modal, Form, Input, Button } from 'antd'

const ListenMessageNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [config, setConfig] = useState(
    data.config || {
      contact: '',
      group: '',
      keywords: []
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
          border: '2px solid #1890ff',
          borderRadius: 5,
          background: '#e6f7ff',
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
        <Handle type="target" position={Position.Top} style={{ background: '#1890ff' }} />
        <MessageOutlined style={{ color: '#1890ff', marginRight: 5 }} />
        <div>{data.label || '监听消息'}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 5 }}>
          {config.contact ? `联系人: ${config.contact}` : config.group ? `群聊: ${config.group}` : '未配置'}
        </div>
        <Handle type="source" position={Position.Bottom} style={{ background: '#1890ff' }} />

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
        title="配置监听消息节点"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        onOk={() => {
          const form = document.getElementById(`listen-form-${id}`) as HTMLFormElement
          if (form) {
            const formData = new FormData(form)
            saveConfig({
              contact: formData.get('contact') as string,
              group: formData.get('group') as string,
              keywords: (formData.get('keywords') as string).split(',').filter((k) => k.trim())
            })
          }
        }}>
        <form id={`listen-form-${id}`}>
          <Form layout="vertical">
            <Form.Item label="联系人" name="contact">
              <Input name="contact" defaultValue={config.contact} placeholder="要监听的联系人名称" />
            </Form.Item>
            <Form.Item label="群聊" name="group">
              <Input name="group" defaultValue={config.group} placeholder="要监听的群聊名称" />
            </Form.Item>
            <Form.Item label="关键词" name="keywords">
              <Input.TextArea
                name="keywords"
                defaultValue={config.keywords.join(',')}
                placeholder="用逗号分隔关键词"
                rows={3}
              />
            </Form.Item>
          </Form>
        </form>
      </Modal>
    </>
  )
}

export default ListenMessageNode
