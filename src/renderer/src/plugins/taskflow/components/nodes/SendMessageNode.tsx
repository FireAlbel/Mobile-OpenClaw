import React, { useState } from 'react'
import { Handle, Position } from 'reactflow'
import { SendOutlined, CloseOutlined } from '@ant-design/icons'
import { Modal, Form, Input, Switch, Button } from 'antd'

const SendMessageNode: React.FC<{ data: any; id: string }> = ({ data, id }) => {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [config, setConfig] = useState(
    data.config || {
      contact: '',
      group: '',
      message: '',
      useTemplate: false
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
          border: '2px solid #eb2f96',
          borderRadius: 5,
          background: '#fff0f6',
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
        <Handle type="target" position={Position.Top} style={{ background: '#eb2f96' }} />
        <SendOutlined style={{ color: '#eb2f96', marginRight: 5 }} />
        <div>{data.label || '发送消息'}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 5 }}>
          {config.contact ? `联系人: ${config.contact}` : config.group ? `群聊: ${config.group}` : '未配置'}
        </div>
        <Handle type="source" position={Position.Bottom} style={{ background: '#eb2f96' }} />

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
        title="配置发送消息节点"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        onOk={() => {
          const form = document.getElementById(`send-form-${id}`) as HTMLFormElement
          if (form) {
            const formData = new FormData(form)
            saveConfig({
              contact: formData.get('contact') as string,
              group: formData.get('group') as string,
              message: formData.get('message') as string,
              useTemplate: formData.get('useTemplate') === 'on'
            })
          }
        }}
        width={500}>
        <form id={`send-form-${id}`}>
          <Form layout="vertical">
            <Form.Item label="联系人" name="contact">
              <Input name="contact" defaultValue={config.contact} placeholder="要发送的联系人名称" />
            </Form.Item>
            <Form.Item label="群聊" name="group">
              <Input name="group" defaultValue={config.group} placeholder="要发送的群聊名称" />
            </Form.Item>
            <Form.Item label="消息内容" name="message">
              <Input.TextArea
                name="message"
                defaultValue={config.message}
                placeholder="输入消息内容，支持模板变量"
                rows={4}
              />
            </Form.Item>
            <Form.Item label="使用模板" name="useTemplate" valuePropName="checked">
              <Switch defaultChecked={config.useTemplate} />
            </Form.Item>
          </Form>
        </form>
      </Modal>
    </>
  )
}

export default SendMessageNode
