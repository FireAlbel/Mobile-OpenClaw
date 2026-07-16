import { deviceCoordinateService } from '@renderer/services/DeviceCoordinateService'
import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { scrcpyFrameService } from '@renderer/services/ScrcpyFrameService'
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
  const [longPressDuration, setLongPressDuration] = useState<string>('800')
  const [doubleTapInterval, setDoubleTapInterval] = useState<string>('120')
  const [swipeX1, setSwipeX1] = useState<string>('500')
  const [swipeY1, setSwipeY1] = useState<string>('1000')
  const [swipeX2, setSwipeX2] = useState<string>('500')
  const [swipeY2, setSwipeY2] = useState<string>('500')
  const [dragDuration, setDragDuration] = useState<string>('700')
  const [packageName, setPackageName] = useState<string>('')

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLog((prev) => [...prev, `[${timestamp}] ${message}`])
  }

  const downloadScreenshot = (imageBase64: string) => {
    const link = document.createElement('a')
    link.href = `data:image/png;base64,${imageBase64}`
    link.download = `device-${serial}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleTap = async () => {
    try {
      const screen = await deviceServiceProxy.getScreenSize(serial)
      const point = deviceCoordinateService.parsePoint(tapX, tapY, screen)
      if (!point) {
        addLog(t('device.control_panel.coordinate_error'))
        return
      }

      addLog(`${t('device.control_panel.tap')} (${point.x}, ${point.y})`)
      await deviceServiceProxy.sendTap(serial, point.x, point.y)
      addLog(t('device.control_panel.tap_success'))
    } catch (error) {
      addLog(t('device.control_panel.tap_failed'))
    }
  }

  const handleDoubleTap = async () => {
    try {
      const interval = parseInt(doubleTapInterval) || 120
      const screen = await deviceServiceProxy.getScreenSize(serial)
      const point = deviceCoordinateService.parsePoint(tapX, tapY, screen)
      if (!point) {
        addLog(t('device.control_panel.coordinate_error'))
        return
      }

      addLog(`双击 (${point.x}, ${point.y})`)
      await deviceServiceProxy.sendDoubleTap(serial, point.x, point.y, interval)
      addLog('双击操作成功')
    } catch (error) {
      addLog('双击操作失败')
    }
  }

  const handleLongPress = async () => {
    try {
      const duration = parseInt(longPressDuration) || 800
      const screen = await deviceServiceProxy.getScreenSize(serial)
      const point = deviceCoordinateService.parsePoint(tapX, tapY, screen)
      if (!point) {
        addLog(t('device.control_panel.coordinate_error'))
        return
      }

      addLog(`长按 (${point.x}, ${point.y}) ${duration}ms`)
      await deviceServiceProxy.sendLongPress(serial, point.x, point.y, duration)
      addLog('长按操作成功')
    } catch (error) {
      addLog('长按操作失败')
    }
  }

  const handleSwipe = async () => {
    try {
      const screen = await deviceServiceProxy.getScreenSize(serial)
      const action = deviceCoordinateService.parseRectAction(swipeX1, swipeY1, swipeX2, swipeY2, screen)
      if (!action) {
        addLog(t('device.control_panel.coordinate_error'))
        return
      }

      addLog(`${t('device.control_panel.swipe')}: (${action.x1}, ${action.y1}) -> (${action.x2}, ${action.y2})`)
      await deviceServiceProxy.sendSwipe(serial, action.x1, action.y1, action.x2, action.y2)
      addLog(t('device.control_panel.swipe_success'))
    } catch (error) {
      addLog(t('device.control_panel.swipe_failed'))
    }
  }

  const handleDrag = async () => {
    try {
      const duration = parseInt(dragDuration) || 700
      const screen = await deviceServiceProxy.getScreenSize(serial)
      const action = deviceCoordinateService.parseRectAction(swipeX1, swipeY1, swipeX2, swipeY2, screen)
      if (!action) {
        addLog(t('device.control_panel.coordinate_error'))
        return
      }

      addLog(`拖拽: (${action.x1}, ${action.y1}) -> (${action.x2}, ${action.y2}) ${duration}ms`)
      await deviceServiceProxy.sendDrag(serial, action.x1, action.y1, action.x2, action.y2, duration)
      addLog('拖拽操作成功')
    } catch (error) {
      addLog('拖拽操作失败')
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
      home: t('device.control_panel.home'),
      back: t('device.control_panel.back'),
      menu: t('device.control_panel.menu'),
      power: t('device.control_panel.power')
    }

    addLog(t('device.control_panel.key_sending', { key: keyNames[key] }))
    try {
      await deviceServiceProxy.sendKeyEvent(
        serial,
        key === 'home' ? 3 : key === 'back' ? 4 : key === 'menu' ? 82 : key === 'power' ? 26 : 3
      )
      addLog(t('device.control_panel.key_success', { key: keyNames[key] }))
    } catch (error) {
      addLog(t('device.control_panel.key_failed', { key: keyNames[key] }))
    }
  }

  const handleAppAction = async (action: 'start' | 'stop' | 'restart' | 'foreground' | 'allow' | 'deny') => {
    try {
      if (action === 'foreground') {
        const app = await deviceServiceProxy.getForegroundApp(serial)
        addLog(`当前前台应用: ${app.packageName}${app.activity ? `/${app.activity}` : ''}`)
        return
      }

      if (action === 'allow' || action === 'deny') {
        const handled = await deviceServiceProxy.handlePermissionDialog(serial, action)
        addLog(handled ? '权限弹窗已处理' : '未找到可处理的权限弹窗')
        return
      }

      const targetPackage = packageName.trim()
      if (!targetPackage) {
        addLog('请输入应用包名')
        return
      }

      if (action === 'start') {
        await deviceServiceProxy.startApp(serial, targetPackage)
        addLog(`已启动应用: ${targetPackage}`)
      } else if (action === 'stop') {
        await deviceServiceProxy.stopApp(serial, targetPackage)
        addLog(`已停止应用: ${targetPackage}`)
      } else {
        await deviceServiceProxy.restartApp(serial, targetPackage)
        addLog(`已重启应用: ${targetPackage}`)
      }
    } catch (error) {
      addLog('应用操作失败')
    }
  }

  const handleReboot = async () => {
    addLog(t('device.control_panel.reboot_sending'))
    // 暂时移除重启功能，因为主进程中没有实现
    const success = false
    addLog(success ? '重启命令已发送' : '重启命令发送失败')
  }

  const handleScreenshot = async () => {
    addLog(t('device.control_panel.screenshot_sending'))
    try {
      const screenshot = await scrcpyFrameService.getLatestFrame(serial)
      downloadScreenshot(screenshot.imageBase64)
      addLog(t('device.control_panel.screenshot_scrcpy_success'))
      addLog(t('device.control_panel.screenshot_saved'))
    } catch (error) {
      addLog(t('device.control_panel.screenshot_failed'))
    }
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
            <Input type="text" value={tapX} onChange={(e) => setTapX(e.target.value)} placeholder="X坐标或50%" />
            <Label>Y坐标:</Label>
            <Input type="text" value={tapY} onChange={(e) => setTapY(e.target.value)} placeholder="Y坐标或80%" />
            <Button onClick={handleTap}>点击</Button>
            <Button onClick={handleDoubleTap}>双击</Button>
          </InputGroup>
          <InputGroup>
            <Label>长按:</Label>
            <Input
              type="number"
              value={longPressDuration}
              onChange={(e) => setLongPressDuration(e.target.value)}
              placeholder="持续ms"
            />
            <Label>双击间隔:</Label>
            <Input
              type="number"
              value={doubleTapInterval}
              onChange={(e) => setDoubleTapInterval(e.target.value)}
              placeholder="间隔ms"
            />
            <Button onClick={handleLongPress}>长按</Button>
          </InputGroup>
        </Section>

        <Section>
          <SectionTitle>滑动操作</SectionTitle>
          <InputGroup>
            <Label>起点X:</Label>
            <Input type="text" value={swipeX1} onChange={(e) => setSwipeX1(e.target.value)} placeholder="起点X或50%" />
            <Label>起点Y:</Label>
            <Input type="text" value={swipeY1} onChange={(e) => setSwipeY1(e.target.value)} placeholder="起点Y或80%" />
          </InputGroup>
          <InputGroup>
            <Label>终点X:</Label>
            <Input type="text" value={swipeX2} onChange={(e) => setSwipeX2(e.target.value)} placeholder="终点X或50%" />
            <Label>终点Y:</Label>
            <Input type="text" value={swipeY2} onChange={(e) => setSwipeY2(e.target.value)} placeholder="终点Y或30%" />
            <Button onClick={handleSwipe}>滑动</Button>
          </InputGroup>
          <InputGroup>
            <Label>拖拽:</Label>
            <Input
              type="number"
              value={dragDuration}
              onChange={(e) => setDragDuration(e.target.value)}
              placeholder="持续ms"
            />
            <Button onClick={handleDrag}>拖拽</Button>
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
          <SectionTitle>应用操作</SectionTitle>
          <InputGroup>
            <Input
              type="text"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              placeholder="应用包名，如 com.tencent.mm"
              style={{ flex: 1 }}
            />
            <Button onClick={() => handleAppAction('start')}>启动</Button>
            <Button onClick={() => handleAppAction('stop')}>停止</Button>
            <Button onClick={() => handleAppAction('restart')}>重启</Button>
          </InputGroup>
          <ButtonGroup>
            <Button onClick={() => handleAppAction('foreground')}>当前前台应用</Button>
            <Button onClick={() => handleAppAction('allow')}>允许权限</Button>
            <Button onClick={() => handleAppAction('deny')}>拒绝权限</Button>
          </ButtonGroup>
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
