import { ActionIconButton } from '@renderer/components/Buttons'
import { useShortcutDisplay } from '@renderer/hooks/useShortcuts'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { Dropdown, Tooltip } from 'antd'
import { Copy, ListEnd, MessageSquareDiff, Workflow } from 'lucide-react'

const newTopicTool = defineTool({
  key: 'new_topic',
  label: (t) => t('chat.input.new_topic', { Command: '' }),

  visibleInScopes: [TopicType.Chat],

  dependencies: {
    actions: ['addNewTopic', 'duplicateRpaTask', 'endRpaTask'] as const
  },

  render: function NewTopicRender(context) {
    const { actions, rpaTask, t } = context
    const newTopicShortcut = useShortcutDisplay('new_topic')

    if (rpaTask) {
      return (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'new-task',
                icon: <Workflow size={16} />,
                label: t('device.rpa.lifecycle.new_task', { defaultValue: 'New task' }),
                onClick: actions.addNewTopic
              },
              {
                key: 'duplicate-task',
                icon: <Copy size={16} />,
                label: t('device.rpa.lifecycle.duplicate_task', { defaultValue: 'Duplicate task' }),
                onClick: actions.duplicateRpaTask
              },
              {
                type: 'divider'
              },
              {
                key: 'end-task',
                danger: true,
                icon: <ListEnd size={16} />,
                label: t('device.rpa.lifecycle.end_task', { defaultValue: 'End task' }),
                onClick: actions.endRpaTask
              }
            ]
          }}>
          <ActionIconButton title={t('device.rpa.lifecycle.task_actions', { defaultValue: 'Task actions' })}>
            <Workflow size={19} />
          </ActionIconButton>
        </Dropdown>
      )
    }

    return (
      <Tooltip
        placement="top"
        title={t('chat.input.new_topic', { Command: newTopicShortcut })}
        mouseLeaveDelay={0}
        arrow>
        <ActionIconButton onClick={actions.addNewTopic}>
          <MessageSquareDiff size={19} />
        </ActionIconButton>
      </Tooltip>
    )
  }
})

// Register the tool
registerTool(newTopicTool)

export default newTopicTool
