import type { TranslationMessageBlock } from '@renderer/types/newMessage'
import { Divider, Typography } from 'antd'
import React from 'react'

interface Props {
  block: TranslationMessageBlock
}

const TranslationBlock: React.FC<Props> = ({ block }) => {
  return (
    <section>
      <Divider />
      <Typography.Paragraph>{block.content}</Typography.Paragraph>
    </section>
  )
}

export default React.memo(TranslationBlock)
