/**
 * RightSidePanel — 右侧边栏容器
 *
 * 在 Agent 模式下显示文件面板，样式与 LeftSidebar 一致。
 * 从全局 atom 读取当前会话 ID 和路径。
 * 管理「会话文件 / 工作区文件 / 代码改动」Tab 切换。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import {
  currentAgentSessionIdAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { compareFocusedSessionIdAtom, comparePairsAtom, findPairContaining } from '@/atoms/compare-atoms'
import { SidePanel } from '@/components/agent/SidePanel'

export function RightSidePanel({ width }: { width?: number }): React.ReactElement | null {
  const appMode = useAtomValue(appModeAtom)
  const primarySessionId = useAtomValue(currentAgentSessionIdAtom)
  const comparePairs = useAtomValue(comparePairsAtom)
  const compareFocusedSessionId = useAtomValue(compareFocusedSessionIdAtom)
  // 当前活跃 session 属于某配对时，焦点 session 可以在配对两侧间切换
  const compareMatch = primarySessionId ? findPairContaining(comparePairs, primarySessionId) : null
  const currentSessionId = compareMatch
    && compareFocusedSessionId
    && (compareFocusedSessionId === compareMatch.pair.left || compareFocusedSessionId === compareMatch.pair.right)
    ? compareFocusedSessionId
    : primarySessionId
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)

  const setActiveTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    setDiffPanelTabMap((prev) => {
      const map = new Map(prev)
      map.set(currentSessionId, tab)
      return map
    })
  }, [currentSessionId, setDiffPanelTabMap])

  if (appMode !== 'agent' || !currentSessionId) {
    return null
  }

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const activeTab = diffPanelTabMap.get(currentSessionId) ?? 'session'

  return (
    <SidePanel
      sessionId={currentSessionId}
      sessionPath={sessionPath}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      width={width}
    />
  )
}
