import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DevicePage from '../DevicePage'

const scanDevicesMock = vi.hoisted(() => vi.fn())
const startScrcpyMock = vi.hoisted(() => vi.fn())
const onScrcpyStoppedMock = vi.hoisted(() => vi.fn())
const scrcpyStoppedCallback = vi.hoisted<{
  current: ((payload: { deviceId: string }) => void) | null
}>(() => ({ current: null }))
const configGetMock = vi.hoisted(() => vi.fn())
const configSetMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(
  () => (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
)

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateMock
  })
}))

vi.mock('@renderer/components/Popups/PromptPopup', () => ({
  default: {
    show: vi.fn()
  }
}))

vi.mock('@renderer/services/DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    scanDevices: scanDevicesMock,
    startScrcpy: startScrcpyMock,
    onScrcpyStopped: onScrcpyStoppedMock
  }
}))

vi.mock('../BatchControlPanel', () => ({
  default: () => <div data-testid="batch-control-panel" />
}))

vi.mock('../BatchInstallPanel', () => ({
  default: () => <div data-testid="batch-install-panel" />
}))

vi.mock('../DeviceControlPanel', () => ({
  default: () => <div data-testid="device-control-panel" />
}))

vi.mock('../RpaTaskRunnerPanel', () => ({
  default: () => <div data-testid="rpa-task-runner-panel" />
}))

describe('DevicePage', () => {
  beforeEach(() => {
    scanDevicesMock.mockReset()
    startScrcpyMock.mockReset()
    onScrcpyStoppedMock.mockReset()
    onScrcpyStoppedMock.mockImplementation((callback: (payload: { deviceId: string }) => void) => {
      scrcpyStoppedCallback.current = callback
      return () => {
        scrcpyStoppedCallback.current = null
      }
    })
    scrcpyStoppedCallback.current = null
    configGetMock.mockReset()
    configSetMock.mockReset()
    configGetMock.mockResolvedValue(undefined)

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        config: {
          get: configGetMock,
          set: configSetMock
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  const runInitialScan = async () => {
    await waitFor(() => expect(scanDevicesMock).toHaveBeenCalled(), { timeout: 1000 })
  }

  const renderDevicePage = () => render(<DevicePage initialScanDelayMs={0} refreshIntervalMs={0} />)

  it('shows an empty state when scanning returns no devices', async () => {
    scanDevicesMock.mockResolvedValue([])

    renderDevicePage()
    await runInitialScan()

    await waitFor(() => expect(screen.getByText('device.no_devices')).toBeInTheDocument())
    expect(scanDevicesMock).toHaveBeenCalledTimes(1)
  })

  it('shows an actionable error when scanning fails', async () => {
    scanDevicesMock.mockRejectedValue(new Error('ADB missing'))

    renderDevicePage()
    await runInitialScan()

    await waitFor(() => {
      expect(
        screen.getByText('Failed to scan devices. Please check whether ADB is available and USB debugging is enabled.')
      ).toBeInTheDocument()
    })
    expect(screen.getAllByText('device.refresh').length).toBeGreaterThan(0)
  })

  it('renders grouped and ungrouped devices with hardware details', async () => {
    configGetMock.mockImplementation(async (key: string) => {
      if (key === 'device.groups') return [{ id: 'group-1', name: 'Lab' }]
      if (key === 'device.info') {
        return {
          'device-1': { title: 'QA Pixel', remark: 'Primary test phone', groupId: 'group-1' }
        }
      }
      return undefined
    })
    scanDevicesMock.mockResolvedValue([
      {
        id: 'device-1',
        name: 'Google Pixel 8',
        status: 'online',
        model: 'Pixel 8',
        brand: 'Google',
        androidVersion: '15'
      },
      {
        id: 'device-2',
        name: 'Unknown device',
        status: 'unauthorized'
      }
    ])

    renderDevicePage()
    await runInitialScan()

    await waitFor(() => expect(screen.getByText('Lab (1)')).toBeInTheDocument())
    expect(screen.getByText('QA Pixel')).toBeInTheDocument()
    expect(screen.getByText('Primary test phone')).toBeInTheDocument()
    expect(screen.getByText('Pixel 8')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('Ungrouped Devices')).toBeInTheDocument()
    expect(screen.getByText('device.status.unauthorized')).toBeInTheDocument()
    expect(screen.getByText('Authorize USB debugging on the device, then refresh.')).toBeInTheDocument()
  })

  it('keeps the connect button disabled until scrcpy stops', async () => {
    scanDevicesMock.mockResolvedValue([
      {
        id: 'device-1',
        name: 'Google Pixel 8',
        status: 'online'
      }
    ])
    startScrcpyMock.mockResolvedValue({ port: 8080 })

    renderDevicePage()
    await runInitialScan()

    const connectButton = await screen.findByRole('button', { name: 'device.connect' })
    fireEvent.click(connectButton)

    await waitFor(() => expect(startScrcpyMock).toHaveBeenCalledWith('device-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled())

    scrcpyStoppedCallback.current?.({ deviceId: 'device-1' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'device.connect' })).not.toBeDisabled())
  })
})
