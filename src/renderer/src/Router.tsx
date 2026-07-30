import '@renderer/databases'

import type { FC } from 'react'
import { useMemo } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import NavigationHandler from './handler/NavigationHandler'
import { useNavbarPosition } from './hooks/useSettings'
import FilesPage from './pages/files/FilesPage'
import HomePage from './pages/home/HomePage'
import KnowledgePage from './pages/knowledge/KnowledgePage'
import RpaRoleDetailPage from './pages/rpaRoles/RpaRoleDetailPage'
import RpaRolesPage from './pages/rpaRoles/RpaRolesPage'
import RpaTemplateEditor from './pages/rpaTemplates/RpaTemplateEditor'
import RpaTemplatesPage from './pages/rpaTemplates/RpaTemplatesPage'
import SettingsPage from './pages/settings/SettingsPage'
import AssistantPresetsPage from './pages/store/assistants/presets/AssistantPresetsPage'
import RpaTaskFlowExecutionHost from './services/rpa/RpaTaskFlowExecutionHost'

const Router: FC = () => {
  const { navbarPosition } = useNavbarPosition()

  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/store" element={<AssistantPresetsPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/rpa-workflows" element={<RpaTemplatesPage />} />
          <Route path="/rpa-workflows/create" element={<RpaTemplateEditor />} />
          <Route path="/rpa-workflows/edit/:id" element={<RpaTemplateEditor />} />
          <Route path="/rpa-templates" element={<Navigate to="/rpa-workflows" replace />} />
          <Route path="/rpa-templates/create" element={<Navigate to="/rpa-workflows/create" replace />} />
          <Route path="/rpa-templates/edit/:id" element={<LegacyTaskFlowRedirect />} />
          <Route path="/rpa-roles" element={<RpaRolesPage />} />
          <Route path="/rpa-roles/:id" element={<RpaRoleDetailPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
        </Routes>
      </ErrorBoundary>
    )
  }, [])

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <RpaTaskFlowExecutionHost />
        <Sidebar />
        {routes}
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <RpaTaskFlowExecutionHost />
      <NavigationHandler />
      <TabsContainer>{routes}</TabsContainer>
    </HashRouter>
  )
}

const LegacyTaskFlowRedirect: FC = () => {
  const id = window.location.hash.split('/rpa-templates/edit/')[1]?.split('?')[0]
  return <Navigate to={id ? `/rpa-workflows/edit/${id}` : '/rpa-workflows'} replace />
}

export default Router
