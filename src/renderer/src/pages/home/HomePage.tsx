import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAgentSessionInitializer } from '@renderer/hooks/agents/useAgentSessionInitializer'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useActiveTopic } from '@renderer/hooks/useTopic'
import NavigationService from '@renderer/services/NavigationService'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setActiveAgentId, setActiveTopicOrSessionAction } from '@renderer/store/runtime'
import type { Assistant, Topic } from '@renderer/types'
import type { Tab } from '@renderer/types/chat'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { AnimatePresence, motion } from 'motion/react'
import type { CSSProperties, FC, PointerEvent as ReactPointerEvent } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import Chat from './Chat'
import Navbar from './Navbar'
import HomeTabs from './Tabs'

let _activeAssistant: Assistant

const ASSISTANTS_WIDTH_STORAGE_KEY = 'home.assistants.width'
const DEFAULT_ASSISTANTS_WIDTH = 275
const MIN_ASSISTANTS_WIDTH = 260
const MAX_ASSISTANTS_WIDTH = 560
const MIN_CHAT_WIDTH = 520

const clampAssistantsWidth = (width: number) => {
  if (typeof window === 'undefined') {
    return Math.min(Math.max(width, MIN_ASSISTANTS_WIDTH), MAX_ASSISTANTS_WIDTH)
  }

  const maxByViewport = Math.max(MIN_ASSISTANTS_WIDTH, window.innerWidth - MIN_CHAT_WIDTH)
  return Math.min(Math.max(width, MIN_ASSISTANTS_WIDTH), Math.min(MAX_ASSISTANTS_WIDTH, maxByViewport))
}

const getStoredAssistantsWidth = () => {
  const storedWidth = Number(localStorage.getItem(ASSISTANTS_WIDTH_STORAGE_KEY))
  return Number.isFinite(storedWidth) ? clampAssistantsWidth(storedWidth) : DEFAULT_ASSISTANTS_WIDTH
}

const HomePage: FC = () => {
  const { assistants } = useAssistants()
  const navigate = useNavigate()
  const { isLeftNavbar } = useNavbarPosition()
  const [assistantsWidth, setAssistantsWidth] = useState(getStoredAssistantsWidth)
  const [isResizingAssistants, setIsResizingAssistants] = useState(false)
  const [activeHomeTab, setActiveHomeTab] = useState<Tab>('assistants')

  // Initialize agent session hook
  useAgentSessionInitializer()

  const location = useLocation()
  const state = location.state

  const [activeAssistant, _setActiveAssistant] = useState<Assistant>(
    state?.assistant || _activeAssistant || assistants[0]
  )
  const { activeTopic, setActiveTopic: _setActiveTopic } = useActiveTopic(activeAssistant?.id ?? '', state?.topic)
  const { showAssistants, showTopics, topicPosition } = useSettings()
  const dispatch = useDispatch()
  const { chat } = useRuntime()
  const { activeTopicOrSession } = chat
  const assistantPanelStyle = useMemo(
    () => ({ '--assistants-width': `${assistantsWidth}px` }) as CSSProperties,
    [assistantsWidth]
  )

  _activeAssistant = activeAssistant

  const setActiveAssistant = useCallback(
    // TODO: allow to set it as null.
    (newAssistant: Assistant) => {
      if (newAssistant.id === activeAssistant?.id) return
      startTransition(() => {
        _setActiveAssistant(newAssistant)
        if (newAssistant.id !== 'fake') {
          dispatch(setActiveAgentId(null))
        }
        // 同步更新 active topic，避免不必要的重新渲染
        const newTopic = newAssistant.topics[0]
        _setActiveTopic((prev) => (newTopic?.id === prev.id ? prev : newTopic))
      })
    },
    [_setActiveTopic, activeAssistant?.id, dispatch]
  )

  const setActiveTopic = useCallback(
    (newTopic: Topic) => {
      startTransition(() => {
        _setActiveTopic((prev) => (newTopic?.id === prev.id ? prev : newTopic))
        dispatch(newMessagesActions.setTopicFulfilled({ topicId: newTopic.id, fulfilled: false }))
        dispatch(setActiveTopicOrSessionAction('topic'))
      })
    },
    [_setActiveTopic, dispatch]
  )

  useEffect(() => {
    NavigationService.setNavigate(navigate)
  }, [navigate])

  useEffect(() => {
    state?.assistant && setActiveAssistant(state?.assistant)
    state?.topic && setActiveTopic(state?.topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    const canMinimize = topicPosition == 'left' ? !showAssistants : !showAssistants && !showTopics
    window.api.window.setMinimumSize(canMinimize ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

    return () => {
      window.api.window.resetMinimumSize()
    }
  }, [showAssistants, showTopics, topicPosition])

  useEffect(() => {
    document.documentElement.style.setProperty('--assistants-width', `${assistantsWidth}px`)
    localStorage.setItem(ASSISTANTS_WIDTH_STORAGE_KEY, String(assistantsWidth))
  }, [assistantsWidth])

  useEffect(() => {
    const handleWindowResize = () => setAssistantsWidth((width) => clampAssistantsWidth(width))
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  const startResizeAssistants = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!showAssistants) return

      event.preventDefault()
      const startX = event.clientX
      const startWidth = assistantsWidth
      setIsResizingAssistants(true)

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampAssistantsWidth(startWidth + moveEvent.clientX - startX)
        setAssistantsWidth(nextWidth)
      }

      const stopResize = () => {
        setIsResizingAssistants(false)
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [assistantsWidth, showAssistants]
  )

  return (
    <Container id="home-page" style={assistantPanelStyle} $isResizingAssistants={isResizingAssistants}>
      {isLeftNavbar && (
        <Navbar
          activeAssistant={activeAssistant}
          activeTopic={activeTopic}
          setActiveTopic={setActiveTopic}
          setActiveAssistant={setActiveAssistant}
          position="left"
          activeTopicOrSession={activeTopicOrSession}
        />
      )}
      <ContentContainer id={isLeftNavbar ? 'content-container' : undefined}>
        <AnimatePresence initial={false}>
          {showAssistants && (
            <ErrorBoundary>
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: assistantsWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: isResizingAssistants ? 0 : 0.3, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}>
                <HomeTabs
                  activeAssistant={activeAssistant}
                  activeTopic={activeTopic}
                  setActiveAssistant={setActiveAssistant}
                  setActiveTopic={setActiveTopic}
                  position="left"
                  onTabChange={setActiveHomeTab}
                />
              </motion.div>
              <ResizeHandle onPointerDown={startResizeAssistants} aria-label="Resize sidebar" role="separator" />
            </ErrorBoundary>
          )}
        </AnimatePresence>
        <ErrorBoundary>
          <Chat
            assistant={activeAssistant}
            activeTopic={activeTopic}
            setActiveTopic={setActiveTopic}
            setActiveAssistant={setActiveAssistant}
            rpaAvailable={activeHomeTab === 'device'}
          />
        </ErrorBoundary>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div<{ $isResizingAssistants: boolean }>`
  display: flex;
  flex: 1;
  flex-direction: column;
  cursor: ${({ $isResizingAssistants }) => ($isResizingAssistants ? 'col-resize' : 'default')};
  user-select: ${({ $isResizingAssistants }) => ($isResizingAssistants ? 'none' : 'auto')};

  [navbar-position='left'] & {
    max-width: calc(100vw - var(--sidebar-width));
  }
  [navbar-position='top'] & {
    max-width: 100vw;
  }
`

const ResizeHandle = styled.div`
  width: 6px;
  flex: 0 0 6px;
  cursor: col-resize;
  position: relative;
  z-index: 2;
  -webkit-app-region: no-drag;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
    background: transparent;
    transition: background 0.15s ease;
  }

  &:hover::before,
  &:active::before {
    background: var(--color-primary);
  }
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  overflow: hidden;

  [navbar-position='top'] & {
    max-width: calc(100vw - 12px);
  }
`

export default HomePage
