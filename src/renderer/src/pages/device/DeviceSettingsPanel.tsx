import { useEffect, useState } from 'react'
import styled from 'styled-components'

interface DeviceSettingsPanelProps {
  onClose: () => void
}

interface DeviceSettings {
  adbPath: string
  scrcpyPath: string
  refreshInterval: number
  scrcpyBitrate: number
  scrcpyMaxSize: number
  scrcpyMaxFps: number
  autoStartServer: boolean
}

const DeviceSettingsPanel: React.FC<DeviceSettingsPanelProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<DeviceSettings>({
    adbPath: 'adb',
    scrcpyPath: 'scrcpy',
    refreshInterval: 5,
    scrcpyBitrate: 8000000,
    scrcpyMaxSize: 1024,
    scrcpyMaxFps: 30,
    autoStartServer: true
  })

  const [detectedAdbPath, setDetectedAdbPath] = useState<string>('')
  const [detectedScrcpyPath, setDetectedScrcpyPath] = useState<string>('')
  const [isDetecting, setIsDetecting] = useState<boolean>(false)

  useEffect(() => {
    loadSettings()
    detectPaths()
  }, [])

  const loadSettings = () => {
    const savedSettings = localStorage.getItem('deviceSettings')
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings))
    }
  }

  const saveSettings = () => {
    localStorage.setItem('deviceSettings', JSON.stringify(settings))
    // 更新服务实例
    updateServiceInstances()
    alert('设置已保存')
  }

  const updateServiceInstances = () => {
    // 更新设置到localStorage
    localStorage.setItem('deviceSettings', JSON.stringify(settings))
  }

  const detectPaths = async () => {
    setIsDetecting(true)

    try {
      // 通过IPC调用主进程检测路径
      const paths = await window.electron.ipcRenderer.invoke('detect-tool-paths')
      if (paths.adbPath) {
        setDetectedAdbPath(paths.adbPath)
      }
      if (paths.scrcpyPath) {
        setDetectedScrcpyPath(paths.scrcpyPath)
      }
    } catch (error) {
      console.error('检测工具路径失败:', error)
    }

    setIsDetecting(false)
  }


  const resetToDefaults = () => {
    setSettings({
      adbPath: 'adb',
      scrcpyPath: 'scrcpy',
      refreshInterval: 5,
      scrcpyBitrate: 8000000,
      scrcpyMaxSize: 1024,
      scrcpyMaxFps: 30,
      autoStartServer: true
    })
  }

  return (
    <Panel>
      <Header>
        <Title>设备设置</Title>
        <CloseButton onClick={onClose}>×</CloseButton>
      </Header>

      <Content>
        <Section>
          <SectionTitle>路径设置</SectionTitle>

          <SettingItem>
            <Label>ADB路径:</Label>
            <InputGroup>
              <Input
                type="text"
                value={settings.adbPath}
                onChange={(e) => setSettings(prev => ({ ...prev, adbPath: e.target.value }))}
                placeholder="ADB可执行文件路径"
              />
              {detectedAdbPath && detectedAdbPath !== settings.adbPath && (
                <Button onClick={() => {
                  setSettings(prev => ({ ...prev, adbPath: detectedAdbPath }))
                }}>
                  使用检测到的路径
                </Button>
              )}
            </InputGroup>
            {isDetecting && <InfoText>正在检测路径...</InfoText>}
            {detectedAdbPath && <InfoText>检测到的ADB路径: {detectedAdbPath}</InfoText>}
          </SettingItem>

          <SettingItem>
            <Label>Scrcpy路径:</Label>
            <InputGroup>
              <Input
                type="text"
                value={settings.scrcpyPath}
                onChange={(e) => setSettings(prev => ({ ...prev, scrcpyPath: e.target.value }))}
                placeholder="Scrcpy可执行文件路径"
              />
              {detectedScrcpyPath && detectedScrcpyPath !== settings.scrcpyPath && (
                <Button onClick={() => {
                  setSettings(prev => ({ ...prev, scrcpyPath: detectedScrcpyPath }))
                }}>
                  使用检测到的路径
                </Button>
              )}
            </InputGroup>
            {detectedScrcpyPath && <InfoText>检测到的Scrcpy路径: {detectedScrcpyPath}</InfoText>}
          </SettingItem>
        </Section>

        <Section>
          <SectionTitle>设备刷新设置</SectionTitle>

          <SettingItem>
            <Label>刷新间隔 (秒):</Label>
            <Input
              type="number"
              value={settings.refreshInterval}
              onChange={(e) => setSettings(prev => ({ ...prev, refreshInterval: parseInt(e.target.value) || 5 }))}
              min="1"
              max="60"
            />
          </SettingItem>

          <SettingItem>
            <CheckboxLabel>
              <input
                type="checkbox"
                checked={settings.autoStartServer}
                onChange={(e) => setSettings(prev => ({ ...prev, autoStartServer: e.target.checked }))}
              />
              自动启动ADB服务器
            </CheckboxLabel>
          </SettingItem>
        </Section>

        <Section>
          <SectionTitle>投屏设置</SectionTitle>

          <SettingItem>
            <Label>码率 (bps):</Label>
            <Input
              type="number"
              value={settings.scrcpyBitrate}
              onChange={(e) => setSettings(prev => ({ ...prev, scrcpyBitrate: parseInt(e.target.value) || 8000000 }))}
              min="100000"
              max="50000000"
            />
            <InfoText>推荐值: 8000000 (8Mbps)</InfoText>
          </SettingItem>

          <SettingItem>
            <Label>最大尺寸 (像素):</Label>
            <Input
              type="number"
              value={settings.scrcpyMaxSize}
              onChange={(e) => setSettings(prev => ({ ...prev, scrcpyMaxSize: parseInt(e.target.value) || 1024 }))}
              min="480"
              max="3840"
            />
            <InfoText>推荐值: 1024 (适合大多数屏幕)</InfoText>
          </SettingItem>

          <SettingItem>
            <Label>最大帧率 (fps):</Label>
            <Input
              type="number"
              value={settings.scrcpyMaxFps}
              onChange={(e) => setSettings(prev => ({ ...prev, scrcpyMaxFps: parseInt(e.target.value) || 30 }))}
              min="1"
              max="120"
            />
            <InfoText>推荐值: 30 (平衡性能和质量)</InfoText>
          </SettingItem>
        </Section>

        <ButtonGroup>
          <Button onClick={saveSettings}>保存设置</Button>
          <Button onClick={resetToDefaults} style={{ background: '#666' }}>
            恢复默认
          </Button>
        </ButtonGroup>
      </Content>
    </Panel>
  )
}

const Panel = styled.div`
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

const SettingItem = styled.div`
  margin-bottom: 16px;
`

const Label = styled.label`
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
`

const InputGroup = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`

const Input = styled.input`
  flex: 1;
  padding: 8px;
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

const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
`

const Button = styled.button`
  padding: 8px 16px;
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
  justify-content: flex-end;
  margin-top: 20px;
`

const InfoText = styled.div`
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
`

export default DeviceSettingsPanel
