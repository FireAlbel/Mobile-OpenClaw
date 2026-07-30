import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import DeviceManagementModal from '../DeviceManagementModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('antd', () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null)
}))

vi.mock('../DevicePage', () => ({
  default: ({ refreshIntervalMs }: { refreshIntervalMs: number }) => (
    <div data-testid="device-page" data-refresh-interval={refreshIntervalMs} />
  )
}))

describe('DeviceManagementModal', () => {
  it('mounts manual device management only while the dialog is open', () => {
    const { rerender } = render(<DeviceManagementModal open={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('device-page')).not.toBeInTheDocument()

    rerender(<DeviceManagementModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('device-page')).toHaveAttribute('data-refresh-interval', '0')
  })
})
