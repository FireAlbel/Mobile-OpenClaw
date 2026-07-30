import { describe, expect, it } from 'vitest'

import { RpaUiTreeService } from '../RpaUiTreeService'

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="视频" resource-id="com.example:id/video" class="android.widget.TextView" package="com.example" content-desc="视频入口" clickable="true" enabled="true" bounds="[100,200][500,600]" />
</hierarchy>`

describe('RpaUiTreeService', () => {
  it('parses UI nodes and resolves text targets with normalized bounds', () => {
    const service = new RpaUiTreeService()
    const tree = service.parse(xml, {
      physicalSize: { width: 1080, height: 2400 },
      screenshotSize: { width: 540, height: 1200 },
      capturedAt: 1
    })

    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0]).toMatchObject({
      text: '视频',
      resourceId: 'com.example:id/video',
      clickable: true,
      bounds: { physical: { centerX: 300, centerY: 400 }, screenshot: { centerX: 150, centerY: 200 } }
    })
    expect(service.findByText(tree, '视频')).toHaveLength(1)
    expect(service.findByText(tree, '不存在')).toHaveLength(0)
  })
})
