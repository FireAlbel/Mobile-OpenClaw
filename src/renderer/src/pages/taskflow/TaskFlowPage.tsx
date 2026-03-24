import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { Tabs } from 'antd'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import TaskList from '../../plugins/taskflow/components/TaskList'
import TaskLogs from '../../plugins/taskflow/components/TaskLogs'

const TaskFlowPage: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()

  const getActiveTab = () => {
    if (location.pathname.includes('/logs')) return 'logs'
    return 'list'
  }

  const handleTabChange = (key: string) => {
    if (key === 'list') {
      navigate('/taskflow')
    } else if (key === 'logs') {
      navigate('/taskflow/logs')
    }
  }

  return (
    <Container id="taskflow-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('taskflow.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <TabsContainer>
          <Tabs
            activeKey={getActiveTab()}
            onChange={handleTabChange}
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'list',
                label: t('taskflow.list.title'),
                children: <TaskList />
              },
              {
                key: 'logs',
                label: t('taskflow.logs.title'),
                children: <TaskLogs />
              }
            ]}
          />
        </TabsContainer>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 0;
`

const TabsContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  max-width: 100%;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  padding: 20px;
`

export default TaskFlowPage
