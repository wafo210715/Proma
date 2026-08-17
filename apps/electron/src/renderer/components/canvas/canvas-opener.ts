/**
 * Canvas 侧边分屏入口。
 *
 * 与 Scratch Pad / Browser 的 tear-off 保持同一交互模式：
 * - openCanvasInSplit: 回到最近的 Agent 会话，把全局画布固定到右侧分屏
 * - openSessionCanvasInSplit: 打开指定 session 的专属画布到右侧分屏
 * - closeCanvasInSplit: 关闭分屏，恢复 Canvas 固定 Tab
 *
 * 互斥：Scratch Pad / Browser / Canvas 三者共享右侧槽位，同时只显示一个。
 */

import type { useStore } from 'jotai'
import {
  activeTabIdAtom,
  scratchPadPanelOpenAtom,
  canvasPanelOpenAtom,
  canvasPanelSessionIdAtom,
  SCRATCH_PAD_ID,
  SCRATCH_PAD_TITLE,
  CANVAS_ID,
  CANVAS_TITLE,
  tabsAtom,
  type TabItem,
} from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'

interface CanvasAgentSession {
  id: string
  title: string
  archived?: boolean
  workspaceId?: string
}

type JotaiStore = ReturnType<typeof useStore>

function createCanvasTab(): TabItem {
  return {
    id: CANVAS_ID,
    type: 'canvas',
    sessionId: CANVAS_ID,
    title: CANVAS_TITLE,
  }
}

function findTargetAgentTab(
  tabs: TabItem[],
  sessions: CanvasAgentSession[],
  currentSessionId: string | null,
): TabItem | null {
  const existingAgentTab = [...tabs].reverse().find((tab) => tab.type === 'agent')
  if (existingAgentTab) return existingAgentTab
  if (!currentSessionId) return null

  const session = sessions?.find((item) => item.id === currentSessionId && !item.archived)
  if (!session) return null
  return {
    id: session.id,
    type: 'agent',
    sessionId: session.id,
    title: session.title || 'Agent 会话',
  }
}

/**
 * 打开全局画布到右侧分屏（从 Canvas Tab tear-off）。
 * 语义：移除 Canvas Tab（它已变为分屏面板），激活 Agent 会话。
 */
export function openCanvasInSplit(store: JotaiStore): boolean {
  const tabs = store.get(tabsAtom)
  const canvasTab = tabs.find((tab) => tab.id === CANVAS_ID && tab.type === 'canvas')
  if (!canvasTab) return false

  const sessions = store.get(agentSessionsAtom)
  const currentSessionId = store.get(currentAgentSessionIdAtom)
  const agentTab = findTargetAgentTab(tabs, sessions, currentSessionId)
  if (!agentTab) return false

  const baseTabs = tabs.filter((tab) => tab.id !== CANVAS_ID)
  const hasAgentTab = baseTabs.some((tab) => tab.id === agentTab.id)
  const nextTabs = hasAgentTab ? baseTabs : [...baseTabs, agentTab]
  store.set(tabsAtom, nextTabs)
  store.set(activeTabIdAtom, agentTab.id)
  store.set(appModeAtom, 'agent')
  store.set(currentConversationIdAtom, null)
  store.set(currentAgentSessionIdAtom, agentTab.sessionId)

  const session = sessions.find((item) => item.id === agentTab.sessionId)
  if (session?.workspaceId) {
    store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
    window.electronAPI.updateSettings({
      agentWorkspaceId: session.workspaceId,
    }).catch(console.error)
  }

  // 互斥：Scratch / Canvas 二选一
  store.set(scratchPadPanelOpenAtom, false)
  store.set(canvasPanelOpenAtom, true)
  store.set(canvasPanelSessionIdAtom, null) // 全局画布
  return true
}

export function tearOffCanvasToSplit(store: JotaiStore): boolean {
  return openCanvasInSplit(store)
}

/**
 * 打开指定 session 的专属画布到右侧分屏（从 Agent session 内的「开画布」按钮触发）。
 * 不移除 Canvas Tab（全局画布 Tab 保留在顶部），只是右侧分屏切换到 session 画布。
 */
export function openSessionCanvasInSplit(store: JotaiStore, sessionId: string): boolean {
  const sessions = store.get(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId)
  if (!session) return false

  // 互斥：Scratch / Canvas 二选一
  store.set(scratchPadPanelOpenAtom, false)
  store.set(canvasPanelOpenAtom, true)
  store.set(canvasPanelSessionIdAtom, sessionId)
  return true
}

/**
 * 切换 session 画布：已打开则关闭，未打开则打开。
 * 返回切换后的状态（true = 已打开）。
 */
export function toggleSessionCanvas(store: JotaiStore, sessionId: string): boolean {
  const panelOpen = store.get(canvasPanelOpenAtom)
  const panelSessionId = store.get(canvasPanelSessionIdAtom)

  if (panelOpen && panelSessionId === sessionId) {
    // 当前就是这个 session 的画布 → 关闭
    closeCanvasInSplit(store)
    return false
  }
  // 否则打开/切换
  openSessionCanvasInSplit(store, sessionId)
  return true
}

export function closeCanvasInSplit(store: JotaiStore): void {
  const tabs = store.get(tabsAtom)
  store.set(canvasPanelOpenAtom, false)
  store.set(canvasPanelSessionIdAtom, null)

  // 如果 Canvas Tab 已被 tear-off 移除，恢复固定 Tab 顺序
  if (tabs.some((tab) => tab.id === CANVAS_ID)) return

  const nonPinnedTabs = tabs.filter(
    (t) => t.id !== SCRATCH_PAD_ID && t.id !== CANVAS_ID
  )
  const scratchTab: TabItem = tabs.find((t) => t.id === SCRATCH_PAD_ID) ?? {
    id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: SCRATCH_PAD_TITLE,
  }
  const canvasTab: TabItem = tabs.find((t) => t.id === CANVAS_ID) ?? createCanvasTab()
  store.set(tabsAtom, [scratchTab, canvasTab, ...nonPinnedTabs])
}
