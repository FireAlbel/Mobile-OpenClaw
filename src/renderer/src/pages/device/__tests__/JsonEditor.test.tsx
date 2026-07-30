import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ComponentProps, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/CodeEditor', () => ({
  default: ({ value, onChange, onBlur }: ComponentProps<'textarea'> & { onChange?: (value: string) => void }) => (
    <textarea
      aria-label="code editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onBlur={(event) => onBlur?.(event)}
    />
  )
}))

import JsonEditor from '../JsonEditor'

const ControlledEditor = ({ onValidityChange }: { onValidityChange?: (valid: boolean) => void }) => {
  const [value, setValue] = useState('{"enabled":true}')
  return <JsonEditor value={value} onChange={setValue} onValidityChange={onValidityChange} />
}

describe('JsonEditor', () => {
  it('formats valid JSON with two-space indentation', () => {
    render(<ControlledEditor />)

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('textbox')).toHaveValue('{\n  "enabled": true\n}')
  })

  it('preserves invalid input and reports its validity', async () => {
    const onValidityChange = vi.fn()
    render(<ControlledEditor onValidityChange={onValidityChange} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"enabled":' } })

    expect(screen.getByRole('textbox')).toHaveValue('{"enabled":')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeDisabled()
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false, expect.any(String)))
  })
})
