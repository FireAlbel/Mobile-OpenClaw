import { TopView } from '@renderer/components/TopView'
import { useTimer } from '@renderer/hooks/useTimer'
import type { Assistant, Topic } from '@renderer/types'
import { Drawer } from 'antd'
import { useState } from 'react'

import HomeTabs from '../Tabs'

interface ShowParams {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  onOpenDeviceManagement: () => void
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({
  activeAssistant,
  activeTopic,
  setActiveTopic,
  onOpenDeviceManagement,
  resolve
}) => {
  const [open, setOpen] = useState(true)
  const { setTimeoutTimer } = useTimer()

  const onClose = () => {
    setOpen(false)
    setTimeoutTimer('onClose', resolve, 300)
  }

  AssistantsDrawer.hide = onClose

  return (
    <Drawer
      title={null}
      placement="left"
      open={open}
      onClose={onClose}
      rootStyle={{ top: 'var(--navbar-height)', height: 'calc(100vh - var(--navbar-height))' }}
      style={{ width: 'var(--assistants-width)' }}
      styles={{
        header: { display: 'none' },
        body: {
          display: 'flex',
          padding: 0,
          height: '100%',
          overflow: 'hidden',
          backgroundColor: 'var(--color-background-opacity)'
        },
        wrapper: {
          width: 'var(--assistants-width)',
          height: '100%'
        }
      }}>
      <HomeTabs
        activeAssistant={activeAssistant}
        activeTopic={activeTopic}
        setActiveTopic={(topic) => {
          setActiveTopic(topic)
          onClose()
        }}
        onOpenDeviceManagement={() => {
          onOpenDeviceManagement()
          onClose()
        }}
      />
    </Drawer>
  )
}

const TopViewKey = 'AssistantsDrawer'

export default class AssistantsDrawer {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
