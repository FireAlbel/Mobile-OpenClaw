import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import type { RpaStep, RpaTask, RpaValidationIssue } from '@renderer/services/rpa/RpaTypes'
import { Alert, Button, Checkbox, Input, InputNumber, Select, Space, Timeline, Typography } from 'antd'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import JsonEditor from './JsonEditor'

interface Props {
  task: RpaTask
  issues: RpaValidationIssue[]
  onChange: (task: RpaTask) => void
  onJsonValidityChange?: (valid: boolean) => void
}

const moduleOptions = defaultRpaModuleRegistry.listForPlanner().map((module) => ({
  value: module.id,
  label: `${module.name} (${module.id})`
}))

const RpaTimelineEditor: FC<Props> = ({ task, issues, onChange, onJsonValidityChange }) => {
  const { t } = useTranslation()
  const paramsValidity = useRef(new Map<string, boolean>())

  const reportParamsValidity = useCallback(
    (stepId: string, valid: boolean) => {
      paramsValidity.current.set(stepId, valid)
      onJsonValidityChange?.(task.steps.every((step) => paramsValidity.current.get(step.id) !== false))
    },
    [onJsonValidityChange, task.steps]
  )

  useEffect(() => {
    const activeStepIds = new Set(task.steps.map((step) => step.id))
    for (const stepId of paramsValidity.current.keys()) {
      if (!activeStepIds.has(stepId)) paramsValidity.current.delete(stepId)
    }
    onJsonValidityChange?.(task.steps.every((step) => paramsValidity.current.get(step.id) !== false))
  }, [onJsonValidityChange, task.steps])

  const updateStep = (index: number, step: RpaStep) => {
    const steps = [...task.steps]
    steps[index] = step
    onChange({ ...task, steps })
  }

  const moveStep = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= task.steps.length) return
    const steps = [...task.steps]
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    onChange({ ...task, steps })
  }

  const removeStep = (index: number) => {
    if (task.steps.length <= 1) return
    onChange({ ...task, steps: task.steps.filter((_, stepIndex) => stepIndex !== index) })
  }

  const addStep = () => {
    const sequence = task.steps.length + 1
    onChange({
      ...task,
      steps: [
        ...task.steps,
        {
          id: `step-${Date.now()}`,
          name: `Step ${sequence}`,
          moduleId: 'screenshot',
          params: {},
          continueOnFailure: false
        }
      ]
    })
  }

  return (
    <TimelineRoot>
      {issues.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={t('device.rpa.validation_failed', { defaultValue: 'The workflow contains validation errors.' })}
          description={issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')}
        />
      )}
      <Timeline
        items={task.steps.map((step, index) => ({
          color: issues.some((issue) => issue.path.startsWith(`steps.${index}`)) ? 'red' : 'blue',
          children: (
            <StepEditor
              key={step.id}
              step={step}
              index={index}
              total={task.steps.length}
              onChange={(nextStep) => updateStep(index, nextStep)}
              onMove={(offset) => moveStep(index, offset)}
              onRemove={() => removeStep(index)}
              onJsonValidityChange={(valid) => reportParamsValidity(step.id, valid)}
            />
          )
        }))}
      />
      <Button icon={<Plus size={16} />} onClick={addStep}>
        {t('device.rpa.add_step', { defaultValue: 'Add step' })}
      </Button>
    </TimelineRoot>
  )
}

const StepEditor: FC<{
  step: RpaStep
  index: number
  total: number
  onChange: (step: RpaStep) => void
  onMove: (offset: number) => void
  onRemove: () => void
  onJsonValidityChange: (valid: boolean) => void
}> = ({ step, index, total, onChange, onMove, onRemove, onJsonValidityChange }) => {
  const { t } = useTranslation()
  const [paramsText, setParamsText] = useState(() => JSON.stringify(step.params, null, 2))
  const [paramsError, setParamsError] = useState<string>()

  useEffect(() => setParamsText(JSON.stringify(step.params, null, 2)), [step.id, step.params])

  const applyParams = () => {
    try {
      const params = JSON.parse(paramsText) as Record<string, unknown>
      setParamsError(undefined)
      onChange({ ...step, params })
    } catch (error) {
      setParamsError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <StepPanel>
      <StepHeader>
        <div>
          <Typography.Text type="secondary">
            {t('device.rpa.step_number', { defaultValue: 'Step {{number}}', number: index + 1 })}
          </Typography.Text>
          <StepTitle>{step.name}</StepTitle>
        </div>
        <Space size={4}>
          <Button
            type="text"
            icon={<ArrowUp size={16} />}
            disabled={index === 0}
            title={t('device.rpa.move_up', { defaultValue: 'Move up' })}
            onClick={() => onMove(-1)}
          />
          <Button
            type="text"
            icon={<ArrowDown size={16} />}
            disabled={index === total - 1}
            title={t('device.rpa.move_down', { defaultValue: 'Move down' })}
            onClick={() => onMove(1)}
          />
          <Button
            type="text"
            danger
            icon={<Trash2 size={16} />}
            disabled={total <= 1}
            title={t('common.delete')}
            onClick={onRemove}
          />
        </Space>
      </StepHeader>
      <FieldGrid>
        <Field>
          <FieldLabel>{t('device.rpa.step_name', { defaultValue: 'Step name' })}</FieldLabel>
          <Input value={step.name} onChange={(event) => onChange({ ...step, name: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel>{t('device.rpa.module', { defaultValue: 'Module' })}</FieldLabel>
          <Select
            showSearch
            optionFilterProp="label"
            value={step.moduleId}
            options={moduleOptions}
            onChange={(moduleId) => onChange({ ...step, moduleId, params: {} })}
          />
        </Field>
        <Field>
          <FieldLabel>{t('device.rpa.timeout', { defaultValue: 'Timeout (ms)' })}</FieldLabel>
          <InputNumber
            min={100}
            max={600_000}
            value={step.timeoutMs}
            placeholder="Default"
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs: timeoutMs ?? undefined })}
          />
        </Field>
        <Checkbox
          checked={step.continueOnFailure}
          onChange={(event) => onChange({ ...step, continueOnFailure: event.target.checked })}>
          {t('device.rpa.continue_on_failure', { defaultValue: 'Continue after failure' })}
        </Checkbox>
      </FieldGrid>
      <Field>
        <FieldLabel>{t('device.rpa.params', { defaultValue: 'Parameters (JSON)' })}</FieldLabel>
        <JsonEditor
          value={paramsText}
          onChange={setParamsText}
          onBlur={applyParams}
          onValidityChange={onJsonValidityChange}
          error={paramsError}
          ariaLabel={t('device.rpa.params', { defaultValue: 'Parameters (JSON)' })}
        />
      </Field>
    </StepPanel>
  )
}

const TimelineRoot = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 6px 8px 4px;

  .ant-timeline-item-tail {
    border-inline-start: 2px solid var(--color-border);
  }
`

const StepPanel = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px;
  background: var(--color-background-soft);
`

const StepHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
`

const StepTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  margin-top: 2px;
`

const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(200px, 1.2fr) 140px;
  gap: 10px;
  align-items: end;
  margin-bottom: 10px;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
`

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 5px;
`

const FieldLabel = styled.span`
  color: var(--color-text-2);
  font-size: 12px;
`

export default RpaTimelineEditor
