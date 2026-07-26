/**
 * 浏览器侧边分屏入口。
 *
 * 与 Scratch Pad tear-off 保持同一交互：回到最近的 Agent 会话，
 * 并把浏览器固定到右侧分屏。
 *
 * tear-off 语义：打开分屏时把 Browser Tab 从 TabBar 移除，
 * 保证任何时刻只存在一个 <webview> 实例（webview 是 DOM 元素，
 * 不能在两处同时挂载，否则会话状态会分裂）。
 */

import type { useStore } from 'jotai'
import {
  activeTabIdAtom,
  browserPanelOpenAtom,
  scratchPadPanelOpenAtom,
  canvasPanelOpenAtom,
  BROWSER_ID,
  BROWSER_TITLE,
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

interface BrowserAgentSession {
  id: string
  title: string
  archived?: boolean
  workspaceId?: string
}

type JotaiStore = ReturnType<typeof useStore>

function createBrowserTabItem(): TabItem {
  return {
    id: BROWSER_ID,
    type: 'browser',
    sessionId: BROWSER_ID,
    title: BROWSER_TITLE,
  }
}

function findTargetAgentTab(
  tabs: TabItem[],
  sessions: BrowserAgentSession[],
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

export function openBrowserInSplit(store: JotaiStore): boolean {
  const tabs = store.get(tabsAtom)
  const browserTab = tabs.find((tab) => tab.id === BROWSER_ID && tab.type === 'browser')
  if (!browserTab) return false

  const sessions = store.get(agentSessionsAtom)
  const currentSessionId = store.get(currentAgentSessionIdAtom)
  const agentTab = findTargetAgentTab(tabs, sessions, currentSessionId)
  if (!agentTab) return false

  const baseTabs = tabs.filter((tab) => tab.id !== BROWSER_ID)
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

  // 浏览器与草稿/画布互斥：右侧槽位同时塞两个重面板会把地图挤到不可用宽度
  store.set(scratchPadPanelOpenAtom, false)
  store.set(canvasPanelOpenAtom, false)
  store.set(browserPanelOpenAtom, true)
  return true
}

export function tearOffBrowserToSplit(store: JotaiStore): boolean {
  return openBrowserInSplit(store)
}

export function closeBrowserInSplit(store: JotaiStore): void {
  const tabs = store.get(tabsAtom)
  store.set(browserPanelOpenAtom, false)

  if (tabs.some((tab) => tab.id === BROWSER_ID)) return

  // 恢复固定 tab 顺序：草稿 → Canvas → Browser → 会话 tabs
  // 不能简单 prepend，否则 Browser 会跑到草稿前面
  const nonPinnedTabs = tabs.filter(
    (t) => t.id !== SCRATCH_PAD_ID && t.id !== CANVAS_ID && t.id !== BROWSER_ID
  )
  const scratchTab: TabItem = tabs.find((t) => t.id === SCRATCH_PAD_ID) ?? {
    id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: SCRATCH_PAD_TITLE,
  }
  const canvasTab: TabItem = tabs.find((t) => t.id === CANVAS_ID) ?? {
    id: CANVAS_ID, type: 'canvas', sessionId: CANVAS_ID, title: CANVAS_TITLE,
  }
  store.set(tabsAtom, [scratchTab, canvasTab, createBrowserTabItem(), ...nonPinnedTabs])
}
