import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
    alert(t('device.settings.settings_saved'))
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
        <Title>{t('device.settings.title')}</Title>
        <CloseButton onClick={onClose}>×</CloseButton>
      </Header>

      <Content>
        <Section>
          <SectionTitle>{t('device.settings.path_settings')}</SectionTitle>

          <SettingItem>
            <Label>{t('device.settings.adb_path')}:</Label>
            <InputGroup>
              <Input
                type="text"
                value={settings.adbPath}
                onChange={(e) => setSettings((prev) => ({ ...prev, adbPath: e.target.value }))}
                placeholder={t('device.settings.adb_placeholder')}
              />
              {detectedAdbPath && detectedAdbPath !== settings.adbPath && (
                <Button
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, adbPath: detectedAdbPath }))
                  }}>
                  {t('device.settings.use_detected_path')}
                </Button>
              )}
            </InputGroup>
            {isDetecting && <InfoText>{t('device.settings.detecting_path')}</InfoText>}
            {detectedAdbPath && <InfoText>{t('device.settings.adb_detected', { path: detectedAdbPath })}</InfoText>}
          </SettingItem>

          <SettingItem>
            <Label>{t('device.settings.scrcpy_path')}:</Label>
            <InputGroup>
              <Input
                type="text"
                value={settings.scrcpyPath}
                onChange={(e) => setSettings((prev) => ({ ...prev, scrcpyPath: e.target.value }))}
                placeholder={t('device.settings.scrcpy_placeholder')}
              />
              {detectedScrcpyPath && detectedScrcpyPath !== settings.scrcpyPath && (
                <Button
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, scrcpyPath: detectedScrcpyPath }))
                  }}>
                  {t('device.settings.use_detected_path')}
                </Button>
              )}
            </InputGroup>
            {detectedScrcpyPath && (
              <InfoText>{t('device.settings.scrcpy_detected', { path: detectedScrcpyPath })}</InfoText>
            )}
          </SettingItem>
        </Section>

        <Section>
          <SectionTitle>{t('device.settings.refresh_settings')}</SectionTitle>

          <SettingItem>
            <Label>{t('device.settings.refresh_interval')}:</Label>
            <Input
              type="number"
              value={settings.refreshInterval}
              onChange={(e) => setSettings((prev) => ({ ...prev, refreshInterval: parseInt(e.target.value) || 5 }))}
              min="1"
              max="60"
            />
          </SettingItem>

          <SettingItem>
            <CheckboxLabel>
              <input
                type="checkbox"
                checked={settings.autoStartServer}
                onChange={(e) => setSettings((prev) => ({ ...prev, autoStartServer: e.target.checked }))}
              />
              {t('device.settings.auto_start_server')}
            </CheckboxLabel>
          </SettingItem>
        </Section>

        <Section>
          <SectionTitle>{t('device.settings.screen_settings')}</SectionTitle>

          <SettingItem>
            <Label>{t('device.settings.bitrate')}:</Label>
            <Input
              type="number"
              value={settings.scrcpyBitrate}
              onChange={(e) => setSettings((prev) => ({ ...prev, scrcpyBitrate: parseInt(e.target.value) || 8000000 }))}
              min="100000"
              max="50000000"
            />
            <InfoText>{t('device.settings.bitrate_recommendation')}</InfoText>
          </SettingItem>

          <SettingItem>
            <Label>{t('device.settings.max_size')}:</Label>
            <Input
              type="number"
              value={settings.scrcpyMaxSize}
              onChange={(e) => setSettings((prev) => ({ ...prev, scrcpyMaxSize: parseInt(e.target.value) || 1024 }))}
              min="480"
              max="3840"
            />
            <InfoText>{t('device.settings.size_recommendation')}</InfoText>
          </SettingItem>

          <SettingItem>
            <Label>{t('device.settings.max_fps')}:</Label>
            <Input
              type="number"
              value={settings.scrcpyMaxFps}
              onChange={(e) => setSettings((prev) => ({ ...prev, scrcpyMaxFps: parseInt(e.target.value) || 30 }))}
              min="1"
              max="120"
            />
            <InfoText>{t('device.settings.fps_recommendation')}</InfoText>
          </SettingItem>
        </Section>

        <ButtonGroup>
          <Button onClick={saveSettings}>{t('device.settings.save_settings')}</Button>
          <Button onClick={resetToDefaults} style={{ background: '#666' }}>
            {t('device.settings.reset_defaults')}
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
