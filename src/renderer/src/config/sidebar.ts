import type { SidebarIcon } from '@renderer/types/sidebar'

/**
 * 默认显示的侧边栏图标
 * 这些图标会在侧边栏中默认显示
 */
export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = ['assistants', 'rpa_roles', 'rpa_templates']

export const RPA_PRIMARY_SIDEBAR_ICONS = new Set<SidebarIcon>(DEFAULT_SIDEBAR_ICONS)

export function normalizeRpaPrimarySidebarIcons(icons: SidebarIcon[]): SidebarIcon[] {
  const visible = [...new Set(icons)].filter((icon) => RPA_PRIMARY_SIDEBAR_ICONS.has(icon))
  return [...visible, ...DEFAULT_SIDEBAR_ICONS.filter((icon) => !visible.includes(icon))]
}

/**
 * 必须显示的侧边栏图标（不能被隐藏）
 * 这些图标必须始终在侧边栏中可见
 * 抽取为参数方便未来扩展
 */
export const REQUIRED_SIDEBAR_ICONS: SidebarIcon[] = [...DEFAULT_SIDEBAR_ICONS]
