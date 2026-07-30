import { Modal } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import DevicePage from './DevicePage'

interface Props {
  open: boolean
  onClose: () => void
}

const DeviceManagementModal: FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation()

  return (
    <Modal
      title={t('device.management_title')}
      open={open}
      onCancel={onClose}
      footer={null}
      getContainer={() => document.body}
      zIndex={1300}
      width="min(1120px, calc(100vw - 48px))"
      styles={{ body: { height: 'min(760px, calc(100vh - 150px))', padding: 0, overflow: 'hidden' } }}>
      {open && <DevicePage refreshIntervalMs={0} />}
    </Modal>
  )
}

export default DeviceManagementModal
