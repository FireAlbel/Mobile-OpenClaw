import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface BatchInstallPanelProps {
  onClose: () => void
}

interface InstallTask {
  id: string
  serial: string
  packageName: string
  status: 'pending' | 'installing' | 'success' | 'failed'
  error?: string
}

const BatchInstallPanel: React.FC<BatchInstallPanelProps> = ({ onClose }) => {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<any[]>([])
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [apkFiles, setApkFiles] = useState<File[]>([])
  const [installTasks, setInstallTasks] = useState<InstallTask[]>([])
  const [uninstallPackageName, setUninstallPackageName] = useState<string>('')
  const [uninstallTasks, setUninstallTasks] = useState<InstallTask[]>([])
  const [activeTab, setActiveTab] = useState<'install' | 'uninstall'>('install')

  useEffect(() => {
    fetchDevices()
  }, [])

  const fetchDevices = async () => {
    const devices = await deviceServiceProxy.getDevices()
    setDevices(devices)
    setSelectedDevices(devices.map((d) => d.id))
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files) {
      setApkFiles(Array.from(files))
    }
  }

  const handleDeviceSelect = (serial: string) => {
    setSelectedDevices((prev) => (prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]))
  }

  const handleInstall = async () => {
    if (apkFiles.length === 0 || selectedDevices.length === 0) {
      alert(t('device.batch_install.select_apk_and_devices'))
      return
    }

    const tasks: InstallTask[] = []

    for (const file of apkFiles) {
      for (const serial of selectedDevices) {
        tasks.push({
          id: `${serial}_${file.name}_${Date.now()}`,
          serial,
          packageName: file.name,
          status: 'pending'
        })
      }
    }

    setInstallTasks(tasks)

    // 执行安装任务
    for (const task of tasks) {
      setInstallTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: 'installing' } : t)))

      try {
        // 获取文件路径
        const file = apkFiles.find((f) => f.name === task.packageName)
        const filePath = file ? (file as any).path || file.name : task.packageName
        const success = await deviceServiceProxy.installApk(task.serial, filePath)
        setInstallTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: success ? 'success' : 'failed' } : t))
        )
      } catch (error: any) {
        setInstallTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: 'failed', error: error.message } : t))
        )
      }
    }
  }

  const handleUninstall = async () => {
    if (!uninstallPackageName.trim() || selectedDevices.length === 0) {
      alert(t('device.batch_install.input_package_and_devices'))
      return
    }

    const tasks: InstallTask[] = selectedDevices.map((serial) => ({
      id: `${serial}_${uninstallPackageName}_${Date.now()}`,
      serial,
      packageName: uninstallPackageName,
      status: 'pending'
    }))

    setUninstallTasks(tasks)

    // 执行卸载任务
    for (const task of tasks) {
      setUninstallTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: 'installing' } : t)))

      try {
        const success = await deviceServiceProxy.uninstallPackage(task.serial, task.packageName)
        setUninstallTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: success ? 'success' : 'failed' } : t))
        )
      } catch (error: any) {
        setUninstallTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: 'failed', error: error.message } : t))
        )
      }
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return '#52c41a'
      case 'failed':
        return '#ff4d4f'
      case 'installing':
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
      case 'installing':
        return '进行中'
      default:
        return '等待'
    }
  }

  return (
    <Panel>
      <Header>
        <Title>{t('device.batch_install.title')}</Title>
        <CloseButton onClick={onClose}>×</CloseButton>
      </Header>

      <Tabs>
        <Tab active={activeTab === 'install'} onClick={() => setActiveTab('install')}>
          批量安装
        </Tab>
        <Tab active={activeTab === 'uninstall'} onClick={() => setActiveTab('uninstall')}>
          批量卸载
        </Tab>
      </Tabs>

      <Content>
        {activeTab === 'install' ? (
          <Section>
            <SectionTitle>选择APK文件</SectionTitle>
            <FileInput type="file" accept=".apk" multiple onChange={handleFileSelect} />

            {apkFiles.length > 0 && (
              <FileList>
                <h4>已选择的APK文件:</h4>
                {apkFiles.map((file, index) => (
                  <FileItem key={index}>{file.name}</FileItem>
                ))}
              </FileList>
            )}

            <SectionTitle>选择设备</SectionTitle>
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

            <ActionButton onClick={handleInstall} disabled={apkFiles.length === 0 || selectedDevices.length === 0}>
              开始安装
            </ActionButton>

            {installTasks.length > 0 && (
              <TaskList>
                <h4>安装任务:</h4>
                {installTasks.map((task) => (
                  <TaskItem key={task.id}>
                    <TaskInfo>
                      <div>{task.packageName}</div>
                      <small>{task.serial}</small>
                    </TaskInfo>
                    <TaskStatus status={task.status} color={getStatusColor(task.status)}>
                      {getStatusText(task.status)}
                    </TaskStatus>
                  </TaskItem>
                ))}
              </TaskList>
            )}
          </Section>
        ) : (
          <Section>
            <SectionTitle>{t('device.batch_install.package_name')}</SectionTitle>
            <Input
              type="text"
              placeholder={t('device.batch_install.package_name')}
              value={uninstallPackageName}
              onChange={(e) => setUninstallPackageName(e.target.value)}
            />

            <SectionTitle>{t('device.batch_install.select_devices')}</SectionTitle>
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

            <ActionButton
              onClick={handleUninstall}
              disabled={!uninstallPackageName.trim() || selectedDevices.length === 0}>
              开始卸载
            </ActionButton>

            {uninstallTasks.length > 0 && (
              <TaskList>
                <h4>卸载任务:</h4>
                {uninstallTasks.map((task) => (
                  <TaskItem key={task.id}>
                    <TaskInfo>
                      <div>{task.packageName}</div>
                      <small>{task.serial}</small>
                    </TaskInfo>
                    <TaskStatus status={task.status} color={getStatusColor(task.status)}>
                      {getStatusText(task.status)}
                    </TaskStatus>
                  </TaskItem>
                ))}
              </TaskList>
            )}
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

const Tabs = styled.div`
  display: flex;
  border-bottom: 1px solid var(--color-border);
`

const Tab = styled.button<{ active: boolean }>`
  flex: 1;
  padding: 12px;
  background: ${(props) => (props.active ? 'var(--color-background-soft)' : 'transparent')};
  border: none;
  cursor: pointer;
  font-weight: 500;
  color: ${(props) => (props.active ? 'var(--color-primary)' : 'var(--color-text)')};
  border-bottom: 2px solid ${(props) => (props.active ? 'var(--color-primary)' : 'transparent')};

  &:hover {
    background: var(--color-background-soft);
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

const FileInput = styled.input`
  margin-bottom: 16px;
`

const FileList = styled.div`
  margin-bottom: 16px;
`

const FileItem = styled.div`
  padding: 8px;
  background: var(--color-background-soft);
  border-radius: 4px;
  margin-bottom: 4px;
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

const Input = styled.input`
  width: 100%;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  margin-bottom: 16px;
  background: var(--color-background-soft);
  color: var(--color-text);
`

const ActionButton = styled.button`
  width: 100%;
  padding: 12px;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 500;

  &:hover:not(:disabled) {
    background: var(--color-primary-soft);
  }

  &:disabled {
    background: var(--color-text-tertiary);
    cursor: not-allowed;
  }
`

const TaskList = styled.div`
  margin-top: 20px;
  border-top: 1px solid var(--color-border);
  padding-top: 16px;
`

const TaskItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  background: var(--color-background-soft);
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

export default BatchInstallPanel
