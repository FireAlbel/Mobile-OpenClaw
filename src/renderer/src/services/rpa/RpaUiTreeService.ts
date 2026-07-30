import { XMLParser } from 'fast-xml-parser'

import { parseAndroidBounds, RpaCoordinateMapper } from './RpaCoordinateMapper'
import type { RpaUiNode, RpaUiTreeObservation } from './RpaTypes'

interface RpaUiTreeParseOptions {
  physicalSize: { width: number; height: number }
  screenshotSize?: { width: number; height: number }
  capturedAt?: number
}

export class RpaUiTreeService {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    trimValues: false
  })

  parse(xml: string, options: RpaUiTreeParseOptions): RpaUiTreeObservation {
    if (!xml.trim()) throw new Error('UI tree XML is empty')
    const parsed = this.parser.parse(xml) as unknown
    const mapper = new RpaCoordinateMapper({ physical: options.physicalSize, screenshot: options.screenshotSize })
    const nodes: RpaUiNode[] = []
    this.collectNodes(parsed, mapper, nodes)
    return {
      xml,
      nodes,
      texts: [...new Set(nodes.flatMap((node) => [node.text, node.contentDescription]).filter(Boolean))],
      capturedAt: options.capturedAt ?? Date.now()
    }
  }

  findByText(tree: RpaUiTreeObservation, target: string, exact = false): RpaUiNode[] {
    const normalizedTarget = normalizeText(target)
    if (!normalizedTarget) return []
    return tree.nodes.filter((node) => {
      const values = [node.text, node.contentDescription].map(normalizeText).filter(Boolean)
      return exact
        ? values.some((value) => value === normalizedTarget)
        : values.some((value) => value.includes(normalizedTarget))
    })
  }

  private collectNodes(value: unknown, mapper: RpaCoordinateMapper, output: RpaUiNode[]): void {
    if (Array.isArray(value)) {
      for (const item of value) this.collectNodes(item, mapper, output)
      return
    }
    if (!isRecord(value)) return

    const parsedBounds = typeof value.bounds === 'string' ? parseAndroidBounds(value.bounds) : undefined
    if (parsedBounds) {
      output.push({
        id: `ui-node-${output.length + 1}`,
        index: toOptionalNumber(value.index),
        text: toString(value.text),
        resourceId: toString(value['resource-id']),
        className: toString(value.class),
        packageName: toString(value.package),
        contentDescription: toString(value['content-desc']),
        clickable: toBoolean(value.clickable),
        enabled: toBoolean(value.enabled, true),
        selected: toBoolean(value.selected),
        scrollable: toBoolean(value.scrollable),
        bounds: mapper.normalizePhysicalBounds(parsedBounds)
      })
    }

    for (const nested of Object.values(value)) this.collectNodes(nested, mapper, output)
  }
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
}

function toOptionalNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaUiTreeService = new RpaUiTreeService()
