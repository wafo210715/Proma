/**
 * Proma 可配置内置能力开关。
 *
 * 这里只有需要用户配置凭据或显式启用的能力；自动化与协作属于 Pi runtime
 * 基础工具，始终按会话上下文注入，不在此处登记或展示。
 */

import { getSettings, updateSettings } from '../settings-service'
import { getToolState, updateToolState } from '../chat-tool-config'

const NANO_BANANA_ID = 'nano-banana'
const GPT_IMAGE_ID = 'gpt-image'

/** Nano Banana / GPT Image 默认关闭，配置好凭据后由用户显式启用。 */
export function isBuiltinMcpDefaultDisabled(id: string): boolean {
  return id === NANO_BANANA_ID || id === GPT_IMAGE_ID
}

export function isBuiltinMcpUserEnabled(id: string): boolean {
  if (id === NANO_BANANA_ID) {
    return (getSettings().builtinMcpEnabledIds ?? []).includes(id)
  }
  if (id === GPT_IMAGE_ID) {
    // GPT Image 的 Agent 注入开关与「设置 → Chat 工具」开关联动，单一事实源：
    // 任一侧开启即全局生效（Chat 模式 + Agent 模式）。
    return getToolState(GPT_IMAGE_ID).enabled
  }
  return true
}

export function setBuiltinMcpUserEnabled(id: string, enabled: boolean): void {
  if (id === NANO_BANANA_ID) {
    const enabledIds = new Set(getSettings().builtinMcpEnabledIds ?? [])
    if (enabled) enabledIds.add(id)
    else enabledIds.delete(id)
    updateSettings({ builtinMcpEnabledIds: Array.from(enabledIds).sort() })
    return
  }
  if (id === GPT_IMAGE_ID) {
    // Agent 能力面板的开关同步写回 Chat 工具开关，保持单一事实源。
    updateToolState(GPT_IMAGE_ID, { enabled })
    return
  }
  throw new Error(`不支持配置内置能力：${id}`)
}
