import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface DeviceControlPanelProps {
  serial: string
  onClose: () => void
}

const DeviceControlPanel: React.FC<DeviceControlPanelProps> = ({ serial, onClose }) => {
  const { t } = useTranslation()
  const [log, setLog] = useState<string[]>([])
  const [inputText, setInputText] = useState<string>('')
  const [tapX, setTapX] = useState<string>('500')
  const [tapY, setTapY] = useState<string>('1000')
  const [swipeX1, setSwipeX1] = useState<string>('500')
  const [swipeY1, setSwipeY1] = useState<string>('1000')
  const [swipeX2, setSwipeX2] = useState<string>('500')
  const [swipeY2, setSwipeY2] = useState<string>('500')

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLog((prev) => [...prev, `[${timestamp}] ${message}`])
  }

  const handleTap = async () => {
    const x = parseInt(tapX)
    const y = parseInt(tapY)

    if (isNaN(x) || isNaN(y)) {
      addLog(t('device.control_panel.coordinate_error'))
      return
    }

    addLog(`${t('device.control_panel.tap')} (${x}, ${y})`)
    try {
      await deviceServiceProxy.sendTap(serial, x, y)
      addLog(t('device.control_panel.tap_success'))
    } catch (error) {
      addLog(t('device.control_panel.tap_failed'))
    }
  }

  const handleSwipe = async () => {
    const x1 = parseInt(swipeX1)
    const y1 = parseInt(swipeY1)
    const x2 = parseInt(swipeX2)
    const y2 = parseInt(swipeY2)

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      addLog(t('device.control_panel.coordinate_error'))
      return
    }

    addLog(`${t('device.control_panel.swipe')}: (${x1}, ${y1}) -> (${x2}, ${y2})`)
    try {
      await deviceServiceProxy.sendSwipe(serial, x1, y1, x2, y2)
      addLog(t('device.control_panel.swipe_success'))
    } catch (error) {
      addLog(t('device.control_panel.swipe_failed'))
    }
  }

  const handleInputText = async () => {
    if (!inputText.trim()) {
      addLog(t('device.control_panel.text_empty'))
      return
    }

    addLog(`${t('device.control_panel.input')}: "${inputText}"`)
    try {
      await deviceServiceProxy.sendText(serial, inputText)
      addLog(t('device.control_panel.input_success'))
    } catch (error) {
      addLog(t('device.control_panel.input_failed'))
    }
    setInputText('')
  }

  const handlePressKey = async (key: 'home' | 'back' | 'menu' | 'power') => {
    const keyNames = {
      home: '主页',
      back: '返回',
      menu: '菜单',
      power: '电源'
    }

    addLog(`按下 ${keyNames[key]} 键`)
    try {
      await deviceServiceProxy.sendKeyEvent(
        serial,
        key === 'home' ? 3 : key === 'back' ? 4 : key === 'menu' ? 82 : key === 'power' ? 26 : 3
      )
      addLog(`${keyNames[key]} 键操作成功`)
    } catch (error) {
      addLog(`${keyNames[key]} 键操作失败`)
    }
  }

  const handleReboot = async () => {
    addLog(t('device.control_panel.reboot_sending'))
    // 暂时移除重启功能，因为主进程中没有实现
    const success = false
    addLog(success ? '重启命令已发送' : '重启命令发送失败')
  }

  const handleScreenshot = async () => {
    addLog(t('device.control_panel.screenshot_not_implemented'))
  }

  return (
    <ControlPanel>
      <Header>
        <Title>{t('device.control_panel.title', { serial })}</Title>
        <CloseButton onClick={onClose}>×</CloseButton>
      </Header>

      <Content>
        <Section>
          <SectionTitle>点击操作</SectionTitle>
          <InputGroup>
            <Label>X坐标:</Label>
            <Input type="number" value={tapX} onChange={(e) => setTapX(e.target.value)} placeholder="X坐标" />
            <Label>Y坐标:</Label>
            <Input type="number" value={tapY} onChange={(e) => setTapY(e.target.value)} placeholder="Y坐标" />
            <Button onClick={handleTap}>点击</Button>
          </InputGroup>
        </Section>

        <Section>
          <SectionTitle>滑动操作</SectionTitle>
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
            <Button onClick={handleSwipe}>滑动</Button>
          </InputGroup>
        </Section>

        <Section>
          <SectionTitle>{t('device.control_panel.input')}</SectionTitle>
          <InputGroup>
            <Input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={t('device.batch_control.input_text')}
              style={{ flex: 1 }}
            />
            <Button onClick={handleInputText}>{t('device.control_panel.input')}</Button>
          </InputGroup>
        </Section>

        <Section>
          <SectionTitle>
            {t('device.control_panel.home')}, {t('device.control_panel.back')}, {t('device.control_panel.menu')},{' '}
            {t('device.control_panel.power')}
          </SectionTitle>
          <ButtonGroup>
            <Button onClick={() => handlePressKey('home')}>{t('device.control_panel.home')}</Button>
            <Button onClick={() => handlePressKey('back')}>{t('device.control_panel.back')}</Button>
            <Button onClick={() => handlePressKey('menu')}>{t('device.control_panel.menu')}</Button>
            <Button onClick={() => handlePressKey('power')}>{t('device.control_panel.power')}</Button>
          </ButtonGroup>
        </Section>

        <Section>
          <SectionTitle>{t('device.control_panel.system_operations')}</SectionTitle>
          <ButtonGroup>
            <Button onClick={handleReboot}>{t('device.control_panel.reboot')}</Button>
            <Button onClick={handleScreenshot}>{t('device.control_panel.screenshot')}</Button>
          </ButtonGroup>
        </Section>

        <Section>
          <SectionTitle>日志</SectionTitle>
          <LogContainer>
            {log.length === 0 ? (
              <LogMessage>暂无操作日志</LogMessage>
            ) : (
              log.map((entry, index) => <LogMessage key={index}>{entry}</LogMessage>)
            )}
          </LogContainer>
        </Section>
      </Content>
    </ControlPanel>
  )
}

const ControlPanel = styled.div`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 600px;
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

const LogContainer = styled.div`
  height: 150px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 8px;
  background: var(--color-background-soft);
  font-family: monospace;
  font-size: 12px;
`

const LogMessage = styled.div`
  margin-bottom: 4px;
  color: var(--color-text);
`

export default DeviceControlPanel
