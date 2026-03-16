import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface BatchControlPanelProps {
  onClose: () => void
}

interface ControlTask {
  id: string
  serial: string
  action: string
  status: 'pending' | 'executing' | 'success' | 'failed'
  error?: string
}

const BatchControlPanel: React.FC<BatchControlPanelProps> = ({ onClose }) => {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<any[]>([])
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [controlTasks, setControlTasks] = useState<ControlTask[]>([])
  const [tapX, setTapX] = useState<string>('500')
  const [tapY, setTapY] = useState<string>('1000')
  const [swipeX1, setSwipeX1] = useState<string>('500')
  const [swipeY1, setSwipeY1] = useState<string>('1000')
  const [swipeX2, setSwipeX2] = useState<string>('500')
  const [swipeY2, setSwipeY2] = useState<string>('500')
  const [inputText, setInputText] = useState<string>('')

  useEffect(() => {
    fetchDevices()
  }, [])

  const fetchDevices = async () => {
    // 简化版本，使用扫描设备
    const devices = await deviceServiceProxy.scanDevices()
    setDevices(devices)
    setSelectedDevices(devices.map((d) => d.id))
  }

  const handleDeviceSelect = (serial: string) => {
    setSelectedDevices((prev) => (prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]))
  }

  const executeBatchAction = async (action: string, actionFunc: (serial: string) => Promise<boolean>) => {
    if (selectedDevices.length === 0) {
      alert(t('device.batch_control.select_device'))
      return
    }

    const tasks: ControlTask[] = selectedDevices.map((serial) => ({
      id: `${serial}_${action}_${Date.now()}`,
      serial,
      action,
      status: 'pending'
    }))

    setControlTasks((prev) => [...prev, ...tasks])

    // 并行执行所有任务
    await Promise.all(
      tasks.map(async (task) => {
        setControlTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: 'executing' } : t)))

        try {
          const success = await actionFunc(task.serial)
          setControlTasks((prev) =>
            prev.map((t) => (t.id === task.id ? { ...t, status: success ? 'success' : 'failed' } : t))
          )
        } catch (error: any) {
          setControlTasks((prev) =>
            prev.map((t) => (t.id === task.id ? { ...t, status: 'failed', error: error.message } : t))
          )
        }
      })
    )
  }

  const handleBatchTap = async () => {
    const x = parseInt(tapX)
    const y = parseInt(tapY)

    if (isNaN(x) || isNaN(y)) {
      alert(t('device.batch_control.coordinate_error'))
      return
    }

    await executeBatchAction(t('device.batch_control.tap'), async (serial) => {
      await deviceServiceProxy.sendTap(serial, x, y)
      return true
    })
  }

  const handleBatchSwipe = async () => {
    const x1 = parseInt(swipeX1)
    const y1 = parseInt(swipeY1)
    const x2 = parseInt(swipeX2)
    const y2 = parseInt(swipeY2)

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      alert(t('device.batch_control.coordinate_error'))
      return
    }

    await executeBatchAction(t('device.batch_control.swipe'), async (serial) => {
      await deviceServiceProxy.sendSwipe(serial, x1, y1, x2, y2)
      return true
    })
  }

  const handleBatchInputText = async () => {
    if (!inputText.trim()) {
      alert(t('device.batch_control.text_empty'))
      return
    }

    await executeBatchAction(t('device.batch_control.input'), async (serial) => {
      await deviceServiceProxy.sendText(serial, inputText)
      return true
    })
  }

  const handleBatchPressKey = async (key: 'home' | 'back' | 'menu' | 'power') => {
    const keyNames = {
      home: '主页',
      back: '返回',
      menu: '菜单',
      power: '电源'
    }

    await executeBatchAction(`按下${keyNames[key]}键`, async (serial) => {
      await deviceServiceProxy.sendKeyEvent(
        serial,
        key === 'home' ? 3 : key === 'back' ? 4 : key === 'menu' ? 82 : key === 'power' ? 26 : 3
      )
      return true
    })
  }

  const handleBatchReboot = async () => {
    // 暂时禁用重启功能
    await executeBatchAction(t('device.batch_control.reboot'), async (_serial) => {
      // 暂时禁用重启功能
      return false
    })
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return '#52c41a'
      case 'failed':
        return '#ff4d4f'
      case 'executing':
        return '#1890ff'
      default:
        return '#d9d9d9'
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'success':
        return '成功'
      case 'failed':
        return '失败'
      case 'executing':
        return '执行中'
      default:
        return '等待'
    }
  }

  const clearTasks = () => {
    setControlTasks([])
  }

  return (
    <Panel>
      <Header>
        <Title>{t('device.batch_control.title')}</Title>
        <CloseButton onClick={onClose}>×</CloseButton>
      </Header>

      <Content>
        <Section>
          <SectionTitle>{t('device.batch_control.select_devices')}</SectionTitle>
          <DeviceList>
            {devices.map((device) => (
              <DeviceItem key={device.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedDevices.includes(device.id)}
                    onChange={() => handleDeviceSelect(device.id)}
                  />
                  {device.id} ({device.status})
                </label>
              </DeviceItem>
            ))}
          </DeviceList>
        </Section>

        <Section>
          <SectionTitle>批量操作</SectionTitle>

          <SubSection>
            <SubSectionTitle>点击操作</SubSectionTitle>
            <InputGroup>
              <Label>X坐标:</Label>
              <Input type="number" value={tapX} onChange={(e) => setTapX(e.target.value)} placeholder="X坐标" />
              <Label>Y坐标:</Label>
              <Input type="number" value={tapY} onChange={(e) => setTapY(e.target.value)} placeholder="Y坐标" />
              <Button onClick={handleBatchTap}>批量点击</Button>
            </InputGroup>
          </SubSection>

          <SubSection>
            <SubSectionTitle>滑动操作</SubSectionTitle>
            <InputGroup>
              <Label>起点X:</Label>
              <Input type="number" value={swipeX1} onChange={(e) => setSwipeX1(e.target.value)} placeholder="起点X" />
              <Label>起点Y:</Label>
              <Input type="number" value={swipeY1} onChange={(e) => setSwipeY1(e.target.value)} placeholder="起点Y" />
            </InputGroup>
            <InputGroup>
              <Label>终点X:</Label>
              <Input type="number" value={swipeX2} onChange={(e) => setSwipeX2(e.target.value)} placeholder="终点X" />
              <Label>终点Y:</Label>
              <Input type="number" value={swipeY2} onChange={(e) => setSwipeY2(e.target.value)} placeholder="终点Y" />
              <Button onClick={handleBatchSwipe}>批量滑动</Button>
            </InputGroup>
          </SubSection>

          <SubSection>
            <SubSectionTitle>{t('device.batch_control.input')}</SubSectionTitle>
            <InputGroup>
              <Input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={t('device.batch_control.input_text')}
                style={{ flex: 1 }}
              />
              <Button onClick={handleBatchInputText}>{t('device.batch_control.batch_input')}</Button>
            </InputGroup>
          </SubSection>

          <SubSection>
            <SubSectionTitle>
              {t('device.control_panel.home')}, {t('device.control_panel.back')}, {t('device.control_panel.menu')},{' '}
              {t('device.control_panel.power')} {t('device.batch_control')}
            </SubSectionTitle>
            <ButtonGroup>
              <Button onClick={() => handleBatchPressKey('home')}>{t('device.batch_control.batch_home')}</Button>
              <Button onClick={() => handleBatchPressKey('back')}>{t('device.batch_control.batch_back')}</Button>
              <Button onClick={() => handleBatchPressKey('menu')}>{t('device.batch_control.batch_menu')}</Button>
              <Button onClick={() => handleBatchPressKey('power')}>{t('device.batch_control.batch_power')}</Button>
            </ButtonGroup>
          </SubSection>

          <SubSection>
            <SubSectionTitle>{t('device.control_panel.reboot')}</SubSectionTitle>
            <ButtonGroup>
              <Button onClick={handleBatchReboot}>{t('device.batch_control.batch_reboot')}</Button>
            </ButtonGroup>
          </SubSection>
        </Section>

        {controlTasks.length > 0 && (
          <Section>
            <SectionTitle>
              {t('device.batch_control.task_log')}
              <ClearButton onClick={clearTasks}>{t('device.batch_control.clear_log')}</ClearButton>
            </SectionTitle>
            <TaskList>
              {controlTasks.slice(-10).map((task) => (
                <TaskItem key={task.id}>
                  <TaskInfo>
                    <div>{task.action}</div>
                    <small>{task.serial}</small>
                  </TaskInfo>
                  <TaskStatus status={task.status} color={getStatusColor(task.status)}>
                    {getStatusText(task.status)}
                  </TaskStatus>
                </TaskItem>
              ))}
            </TaskList>
          </Section>
        )}
      </Content>
    </Panel>
  )
}

const Panel = styled.div`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 700px;
  max-height: 80vh;
  background: var(--color-background);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  display: flex;
  flex-direction: column;
`

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--color-border);
`

const Title = styled.h2`
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
`

const CloseButton = styled.button`
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);

  &:hover {
    color: var(--color-text);
  }
`

const Content = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px;
`

const Section = styled.div`
  margin-bottom: 20px;
`

const SectionTitle = styled.h3`
  margin: 0 0 12px 0;
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text);
  display: flex;
  justify-content: space-between;
  align-items: center;
`

const SubSection = styled.div`
  margin-bottom: 16px;
  padding: 12px;
  background: var(--color-background-soft);
  border-radius: 4px;
`

const SubSectionTitle = styled.h4`
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
`

const DeviceList = styled.div`
  margin-bottom: 16px;
`

const DeviceItem = styled.div`
  padding: 8px;
  background: var(--color-background-soft);
  border-radius: 4px;
  margin-bottom: 4px;
`

const InputGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`

const Label = styled.label`
  font-size: 14px;
  color: var(--color-text);
  min-width: 60px;
`

const Input = styled.input`
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  background: var(--color-background-soft);
  color: var(--color-text);

  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
`

const Button = styled.button`
  padding: 6px 12px;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;

  &:hover {
    background: var(--color-primary-soft);
  }

  &:active {
    transform: scale(0.98);
  }
`

const ButtonGroup = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`

const ClearButton = styled.button`
  padding: 4px 8px;
  background: var(--color-error);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;

  &:hover {
    background: var(--color-error-soft);
  }
`

const TaskList = styled.div`
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 8px;
  background: var(--color-background-soft);
`

const TaskItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  background: var(--color-background);
  border-radius: 4px;
  margin-bottom: 4px;
`

const TaskInfo = styled.div`
  flex: 1;
`

const TaskStatus = styled.div<{ status: string; color: string }>`
  padding: 4px 8px;
  background: ${(props) => props.color};
  color: white;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
`

export default BatchControlPanel
