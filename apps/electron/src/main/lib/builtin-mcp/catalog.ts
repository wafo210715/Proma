/**
 * Proma 内置 MCP 能力目录。
 *
 * 元数据来自 default-mcp.json。旧搜索、生图的凭据与开关不再参与能力目录，
 * 外部 MCP 仍由工作区配置管理。
 */

import type { BuiltinMcpServerSummary } from '@proma/shared'
import { getToolState } from '../chat-tool-config'
import { isGptImageAvailable } from '../chat-tools/gpt-image-tool'
import { getBuiltinMcpDefinitions, type BuiltinMcpDefinition } from './baseline'
import { isBuiltinMcpDefaultDisabled, isBuiltinMcpUserEnabled } from './settings'

function resolveAvailability(
  item: BuiltinMcpDefinition,
): Pick<BuiltinMcpServerSummary, 'enabled' | 'available' | 'availabilityReason'> {
  // 基础设施型（如 proma-cloud）：登录后始终注入，不受用户开关影响
  if (item.toggleable === false) {
    return { enabled: true, available: true }
  }

  const userEnabled = isBuiltinMcpUserEnabled(item.id)
  if (!userEnabled) {
    return {
      enabled: false,
      available: false,
      availabilityReason: isBuiltinMcpDefaultDisabled(item.id)
        ? '默认关闭，可手动开启'
        : '已手动关闭',
    }
  }

  if (item.id === 'gpt-image') {
    const state = getToolState('gpt-image')
    const available = state.enabled && isGptImageAvailable()
    let availabilityReason: string | undefined
    if (!available) {
      availabilityReason = state.enabled ? '需要选择可用的生图模型渠道' : 'GPT Image 未启用'
    }
    return { enabled: true, available, availabilityReason }
  }

  return { enabled: true, available: true }
}

export function listBuiltinMcpServers(): BuiltinMcpServerSummary[] {
  return getBuiltinMcpDefinitions().map((item) => ({
    id: item.id,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    category: item.category,
    tools: item.tools,
    toggleable: item.toggleable,
    enabled: item.defaultEnabled,
    available: item.defaultEnabled,
  }))
}
