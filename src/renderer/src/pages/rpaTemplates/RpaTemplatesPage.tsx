import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaTemplateList from './RpaTemplateList'

const RpaTemplatesPage: FC = () => {
  const { t } = useTranslation()
  return (
    <Container id="rpa-templates-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('rpa_templates.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <RpaTemplateList />
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`display: flex; min-width: 0; flex: 1; flex-direction: column;`
const ContentContainer = styled.div`
  display: flex; min-width: 0; min-height: 0; flex: 1; padding: 20px; overflow: auto;
`

export default RpaTemplatesPage
