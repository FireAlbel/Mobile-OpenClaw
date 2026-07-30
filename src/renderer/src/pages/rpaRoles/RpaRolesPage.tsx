import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaRoleLibrary from './RpaRoleLibrary'

const RpaRolesPage: FC = () => {
  const { t } = useTranslation()
  return (
    <Container id="rpa-roles-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('rpa_roles.title')}</NavbarCenter>
      </Navbar>
      <Content id="content-container">
        <RpaRoleLibrary />
      </Content>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
`

const Content = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  padding: 20px;
  overflow: auto;
`

export default RpaRolesPage
