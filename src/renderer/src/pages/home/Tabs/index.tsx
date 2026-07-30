import { useNavbarPosition } from '@renderer/hooks/useSettings'
import type { Assistant, Topic } from '@renderer/types'
import { Button, Tooltip } from 'antd'
import { ListTodo, Smartphone } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ActiveRpaRuns from './ActiveRpaRuns'
import Topics from './TopicsTab'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  onOpenDeviceManagement: () => void
  style?: React.CSSProperties
}

const HomeTabs: FC<Props> = ({ activeAssistant, activeTopic, setActiveTopic, onOpenDeviceManagement, style }) => {
  const { isLeftNavbar } = useNavbarPosition()
  const { t } = useTranslation()
  const border = isLeftNavbar ? { borderRight: '0.5px solid var(--color-border)' } : undefined

  return (
    <Container style={{ ...border, ...style }} className="home-tabs">
      <WorkspaceHeader>
        <WorkspaceTitle>
          <ListTodo size={17} />
          <span>{t('device.rpa.workspace')}</span>
        </WorkspaceTitle>
        <Tooltip title={t('device.management_title')}>
          <Button
            type="text"
            icon={<Smartphone size={17} />}
            aria-label={t('device.management_title')}
            onClick={onOpenDeviceManagement}
          />
        </Tooltip>
      </WorkspaceHeader>

      <ActiveSection>
        <SectionTitle>
          <span>{t('device.rpa.active_runs')}</span>
        </SectionTitle>
        <ActiveRpaRuns />
      </ActiveSection>

      <TopicsSection>
        <SectionTitle>
          <span>{t('device.rpa.chat_topics')}</span>
        </SectionTitle>
        <TopicsContent>
          <Topics
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            position="left"
          />
        </TopicsContent>
      </TopicsSection>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: var(--assistants-width);
  height: calc(100vh - var(--navbar-height));
  position: relative;
  overflow: hidden;
  background: var(--color-background);

  .collapsed {
    width: 0;
    border-left: none;
  }
`

const WorkspaceHeader = styled.div`
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--color-border);
  -webkit-app-region: no-drag;

  .ant-btn {
    width: 32px;
    height: 32px;
    color: var(--color-text-secondary);
  }
`

const WorkspaceTitle = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 600;
`

const ActiveSection = styled.section`
  max-height: 42%;
  overflow-y: auto;
  border-bottom: 1px solid var(--color-border);
`

const TopicsSection = styled.section`
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
`

const SectionTitle = styled.div`
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
`

const TopicsContent = styled.div`
  min-height: 0;
  flex: 1;
  position: relative;
  overflow: hidden;
`

export default HomeTabs
