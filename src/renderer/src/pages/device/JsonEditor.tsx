import CodeEditor from '@renderer/components/CodeEditor'
import { Button, Typography } from 'antd'
import { Braces } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  value: string
  onChange: (value: string) => void
  onBlur?: (value: string) => void
  onValidityChange?: (valid: boolean, error?: string) => void
  error?: string
  height?: string
  minHeight?: string
  maxHeight?: string
  resizable?: boolean
  ariaLabel?: string
}

export const getJsonSyntaxError = (value: string): string | undefined => {
  try {
    JSON.parse(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const JsonEditor: FC<Props> = ({
  value,
  onChange,
  onBlur,
  onValidityChange,
  error,
  height = '150px',
  minHeight = '110px',
  maxHeight = '520px',
  resizable = false,
  ariaLabel
}) => {
  const { t } = useTranslation()
  const syntaxError = useMemo(() => getJsonSyntaxError(value), [value])
  const displayedError = syntaxError ?? error

  useEffect(() => {
    onValidityChange?.(!syntaxError, syntaxError)
  }, [onValidityChange, syntaxError])

  const formatJson = () => {
    if (syntaxError) return
    onChange(JSON.stringify(JSON.parse(value), null, 2))
  }

  return (
    <Root>
      <Toolbar>
        <Button
          type="text"
          size="small"
          icon={<Braces size={15} />}
          disabled={Boolean(syntaxError)}
          onClick={formatJson}>
          {t('device.rpa.format_json', { defaultValue: 'Format JSON' })}
        </Button>
      </Toolbar>
      <EditorFrame
        $invalid={Boolean(displayedError)}
        $height={height}
        $minHeight={minHeight}
        $maxHeight={maxHeight}
        $resizable={resizable}
        aria-label={ariaLabel}>
        <CodeEditor
          value={value}
          language="json"
          onChange={onChange}
          onBlur={onBlur}
          height="100%"
          minHeight="100%"
          maxHeight="100%"
          expanded={false}
          wrapped={false}
          options={{
            lint: true,
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            keymap: true
          }}
        />
      </EditorFrame>
      {displayedError && (
        <ErrorText type="danger" role="alert">
          {displayedError}
        </ErrorText>
      )}
    </Root>
  )
}

const Root = styled.div`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
`

const Toolbar = styled.div`
  display: flex;
  min-height: 24px;
  justify-content: flex-end;
`

const EditorFrame = styled.div<{
  $invalid: boolean
  $height: string
  $minHeight: string
  $maxHeight: string
  $resizable: boolean
}>`
  height: ${({ $height }) => $height};
  min-height: ${({ $minHeight }) => $minHeight};
  max-height: ${({ $maxHeight }) => $maxHeight};
  overflow: hidden;
  resize: ${({ $resizable }) => ($resizable ? 'vertical' : 'none')};
  border: 1px solid ${({ $invalid }) => ($invalid ? 'var(--color-error)' : 'var(--color-border)')};
  border-radius: 6px;
  background: var(--color-background);

  &:focus-within {
    border-color: ${({ $invalid }) => ($invalid ? 'var(--color-error)' : 'var(--color-primary)')};
  }

  .code-editor,
  .cm-editor {
    height: 100%;
  }

  .cm-scroller {
    overflow: auto;
  }
`

const ErrorText = styled(Typography.Text)`
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

export default JsonEditor
