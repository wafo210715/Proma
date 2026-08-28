/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。文件、Markdown 和 Diff 预览统一由右侧工作区承载；
 * MainArea 仅保留对话主区。
 */

import * as React from 'react'
import type { BrowserStateChange, BrowserTabFocusChange } from '@proma/shared'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  activeTabAtom,
  canvasPanelOpenAtom,
  canvasPanelSessionIdAtom,
} from '@/atoms/tab-atoms'
import { CanvasPane } from '@/components/canvas/CanvasView'
import { closeCanvasInSplit } from '@/components/canvas/canvas-opener'
import { TabErrorBoundary } from './TabErrorBoundary'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { useTrackSessionView } from '@/hooks/useTrackSessionView'
import { AgentView } from '@/components/agent'
import { agentSessionsAtom, agentStreamingStatesAtom } from '@/atoms/agent-atoms'
import {
  compareBroadcastAtom,
  compareFocusedSessionIdAtom,
  compareLinkedAtom,
  comparePairsAtom,
  comparePendingFileLinksAtom,
  compareSplitRatioAtom,
  findPairContaining,
  pendingInheritAtom,
} from '@/atoms/compare-atoms'
import { useCompareActions } from '@/hooks/useCompareActions'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { VaultView } from '@/components/vault/VaultView'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { registerShortcut } from '@/lib/shortcut-registry'
import {
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtomFamily,
  currentSessionSidePanelOpenAtom,
  getBrowserSidePanelTab,
} from '@/atoms/agent-atoms'
import {
  browserPanelMinimizedMapAtom,
  browserPanelOpenMapAtom,
  browserPendingNavigationMapAtom,
  browserStateMapAtom,
} from '@/atoms/browser-atoms'
import { previewSplitRatioAtom } from '@/atoms/preview-atoms'

export function MainArea(): React.ReactElement {
  useTrackSessionView()

  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const store = useStore()

  // TabBar 立即反馈，较重的中心内容可让出当前交互帧；Agent 历史则保持当前会话避免旧内容占屏。
  const deferredActiveTabId = React.useDeferredValue(activeTabId)
  const contentTabId = activeTab?.type === 'agent' ? activeTabId : deferredActiveTabId
  // Agent 会话从左侧历史列表切换，中心区不再重复展示同一组顶部 Tab。
  const showCenterTabBar = activeTab?.type !== 'agent'
  const [isRightPanelOpen, setRightPanelOpen] = useAtom(currentSessionSidePanelOpenAtom)
  const toggleRightPanel = React.useCallback(() => {
    if (activeTab?.type !== 'agent') return
    setRightPanelOpen(!isRightPanelOpen)
  }, [activeTab?.type, isRightPanelOpen, setRightPanelOpen])

  // 不能依赖 TabBar 注册：Agent 会话已不渲染中心 TabBar，快捷键需要在常驻主内容区监听。
  React.useEffect(() => registerShortcut('toggle-right-panel', toggleRightPanel), [toggleRightPanel])

  // 浏览器状态仍由主内容区常驻订阅，右侧工作区只读取 atom 渲染，避免侧栏收起时遗漏状态更新。
  const setBrowserOpenMap = useSetAtom(browserPanelOpenMapAtom)
  const setBrowserMinimizedMap = useSetAtom(browserPanelMinimizedMapAtom)
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const setPendingNavigationMap = useSetAtom(browserPendingNavigationMapAtom)
  const setAgentSidePanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const browserSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null
  // 同一条状态会因原生视图显示/隐藏重复广播；仅新的 Agent 浏览器活动才激活对应右侧 Tab。
  const handledBrowserActivityIdsRef = React.useRef(new Map<string, string>())

  // ── 双开对比（compare）状态 ──
  const agentSessions = useAtomValue(agentSessionsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const [comparePairs, setComparePairs] = useAtom(comparePairsAtom)
  const setCompareFocusedSessionId = useSetAtom(compareFocusedSessionIdAtom)
  const compareLinked = useAtomValue(compareLinkedAtom)
  const [compareSplitRatio, setCompareSplitRatio] = useAtom(compareSplitRatioAtom)
  const setCompareBroadcast = useSetAtom(compareBroadcastAtom)
  const setComparePendingFileLinks = useSetAtom(comparePendingFileLinksAtom)
  const [pendingInherit, setPendingInherit] = useAtom(pendingInheritAtom)
  const { executeInherit } = useCompareActions()
  const compareDragging = React.useRef(false)
  const pendingInheritInFlightRef = React.useRef<typeof pendingInherit>(null)
  const previousComparePairsRef = React.useRef(comparePairs)
  const previousCompareLinkedRef = React.useRef(compareLinked)

  const publishBrowserState = React.useCallback((state: BrowserStateChange) => {
    if ('closed' in state) {
      setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(state.sessionId, false); return next })
      setBrowserMinimizedMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      setBrowserStateMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      setPendingNavigationMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      return
    }
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    const isMinimized = store.get(browserPanelMinimizedMapAtom).get(state.sessionId) === true
    setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(state.sessionId, !isMinimized); return next })

    const activity = state.activity
    const shouldActivateAgentBrowserTab = Boolean(
      activity
      && activeTab?.type === 'agent'
      && activeTab.sessionId === state.sessionId
      && state.agentTabId === state.activeTabId
      && activity.tabId === state.activeTabId
      && handledBrowserActivityIdsRef.current.get(state.sessionId) !== activity.id,
    )
    if (shouldActivateAgentBrowserTab) {
      handledBrowserActivityIdsRef.current.set(state.sessionId, activity!.id)
      store.set(agentSidePanelOpenAtomFamily(state.sessionId), true)
      setAgentSidePanelTabMap((previous) => {
        const next = new Map(previous)
        next.set(state.sessionId, getBrowserSidePanelTab(state.activeTabId))
        return next
      })
    }
  }, [activeTab, setAgentSidePanelTabMap, setBrowserOpenMap, setBrowserMinimizedMap, setBrowserStateMap, setPendingNavigationMap, store])

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserStateChanged
    if (typeof subscribe !== 'function') return
    return subscribe(publishBrowserState)
  }, [publishBrowserState])

  const focusNativeBrowserTab = React.useCallback((change: BrowserTabFocusChange) => {
    // WebContentsView 不在 React DOM 中；点击后台 Browser Pane 的网页正文只能由主进程
    // 把原生 focus 映射回右侧 Pane/Tab 焦点。后台 Agent Session 不得借此抢前台。
    if (activeTab?.type !== 'agent' || activeTab.sessionId !== change.sessionId) return
    store.set(agentSidePanelOpenAtomFamily(change.sessionId), true)
    setAgentSidePanelTabMap((previous) => {
      if (previous.get(change.sessionId) === getBrowserSidePanelTab(change.tabId)) return previous
      const next = new Map(previous)
      next.set(change.sessionId, getBrowserSidePanelTab(change.tabId))
      return next
    })
  }, [activeTab, setAgentSidePanelTabMap, store])

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserTabFocused
    if (typeof subscribe !== 'function') return
    return subscribe(focusNativeBrowserTab)
  }, [focusNativeBrowserTab])

  React.useEffect(() => {
    if (!browserSessionId) return
    const getState = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserState
    if (typeof getState !== 'function') return
    let cancelled = false
    void getState(browserSessionId)
      .then((state) => { if (!cancelled && state) publishBrowserState(state) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserSessionId, publishBrowserState])

  // 当前活跃 tab 对应的配对信息：activePair = 配对对象，activeCompareRole = 当前 session 是 left 还是 right
  const activeSessionId = browserSessionId
  const activeCompareMatch = activeSessionId
    ? findPairContaining(comparePairs, activeSessionId)
    : null
  const activeComparePair = activeCompareMatch?.pair ?? null
  // partner = 当前 tab 的分屏另一侧 session
  const comparePartnerId = activeCompareMatch
    ? (activeCompareMatch.role === 'left' ? activeCompareMatch.pair.right : activeCompareMatch.pair.left)
    : null
  const showComparePane =
    !!activeComparePair &&
    !!comparePartnerId &&
    activeView === 'conversations'

  // 延迟挂载右栏 AgentView：左栏先渲染完毕，下一帧再挂右栏，避免两个重组件同时初始化。
  const [partnerPaneReady, setPartnerPaneReady] = React.useState(false)
  React.useEffect(() => {
    setPartnerPaneReady(false)
    if (!comparePartnerId) return
    const raf = requestAnimationFrame(() => setPartnerPaneReady(true))
    return () => cancelAnimationFrame(raf)
  }, [comparePartnerId])

  // 配对数组变化时丢弃尚未消费的旧广播，防止解绑/重绑后重放旧 prompt。
  React.useEffect(() => {
    if (previousComparePairsRef.current === comparePairs) return
    previousComparePairsRef.current = comparePairs
    setCompareFocusedSessionId(activeSessionId)
    setCompareBroadcast(null)
    setComparePendingFileLinks(new Map())
  }, [comparePairs, activeSessionId, setCompareBroadcast, setCompareFocusedSessionId, setComparePendingFileLinks])

  // 关闭联动即切断现有附件镜像关系；草稿保留在两侧，重新开启时不自动合并。
  React.useEffect(() => {
    const wasLinked = previousCompareLinkedRef.current
    previousCompareLinkedRef.current = compareLinked
    if (wasLinked && !compareLinked) {
      setCompareBroadcast(null)
      setComparePendingFileLinks(new Map())
    }
  }, [compareLinked, setCompareBroadcast, setComparePendingFileLinks])

  // 配对中的 session 被删除时自动清理对应配对。
  // 注意：只检查「之前存在但现在不在列表中」的 session，避免 agentSessions 短暂空窗时误删。
  const previousSessionIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (comparePairs.length === 0) {
      previousSessionIdsRef.current = new Set(agentSessions.map((s) => s.id))
      return
    }
    const currentSessionIds = new Set(agentSessions.map((s) => s.id))
    const prevIds = previousSessionIdsRef.current
    // 只清理「上一轮存在、这一轮消失了」的 session，不因列表短暂空窗误删
    const deletedIds = new Set<string>()
    for (const id of prevIds) {
      if (!currentSessionIds.has(id)) deletedIds.add(id)
    }
    if (deletedIds.size > 0) {
      setComparePairs((prev) =>
        prev.filter((p) => !deletedIds.has(p.left) && !deletedIds.has(p.right)),
      )
    }
    previousSessionIdsRef.current = currentSessionIds
  }, [agentSessions, comparePairs.length, setComparePairs])

  // 待办继承由常驻 MainArea 观察全局流状态，切换 tab 后也能在源会话完成时执行。
  React.useEffect(() => {
    if (!pendingInherit) return
    const source = agentSessions.find((session) => session.id === pendingInherit.sourceSessionId)
    if (!source) {
      setPendingInherit((current) => current === pendingInherit ? null : current)
      toast.error('待办继承已取消', { description: '源会话已不存在。' })
      return
    }
    if (streamingStates.get(source.id)?.running) return
    if (pendingInheritInFlightRef.current === pendingInherit) return

    const task = pendingInherit
    pendingInheritInFlightRef.current = task
    void executeInherit(source, task.targetChannelId, task.targetModelId)
      .then((completed) => {
        if (completed) {
          setPendingInherit((current) => current === task ? null : current)
        }
      })
      .finally(() => {
        if (pendingInheritInFlightRef.current === task) {
          pendingInheritInFlightRef.current = null
        }
      })
  }, [agentSessions, executeInherit, pendingInherit, setPendingInherit, streamingStates])

  // Canvas 分屏面板状态；Browser/Preview 已由上游右侧 SidePanel 标签体系承载。
  const canvasPanelOpen = useAtomValue(canvasPanelOpenAtom)
  const canvasPanelSessionId = useAtomValue(canvasPanelSessionIdAtom)
  const showCanvasPanel =
    activeTab?.type === 'agent' && canvasPanelOpen && activeView === 'conversations'
  const [splitRatio, setSplitRatio] = useAtom(previewSplitRatioAtom)
  const canvasDragging = React.useRef(false)

  const handleCanvasDragStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    canvasDragging.current = true
    const startX = e.clientX
    const startRatio = splitRatio
    const containerEl = (e.currentTarget as HTMLElement).closest('[data-split-container]') as HTMLElement | null
    const containerWidth = containerEl?.clientWidth ?? 1
    let rafId = 0

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = 'none' })

    const onMouseMove = (ev: MouseEvent) => {
      if (!canvasDragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newRatio = Math.max(0.3, Math.min(0.8, startRatio + delta / containerWidth))
        setSplitRatio(newRatio)
      })
    }
    const onMouseUp = () => {
      canvasDragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitRatio, setSplitRatio])

  const handleCompareDragStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    compareDragging.current = true
    const startX = e.clientX
    const startRatio = compareSplitRatio
    const containerEl = (e.currentTarget as HTMLElement).closest('[data-split-container]') as HTMLElement | null
    const containerWidth = containerEl?.clientWidth ?? 1
    let rafId = 0

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = 'none' })

    const onMouseMove = (ev: MouseEvent) => {
      if (!compareDragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newRatio = Math.max(0.3, Math.min(0.7, startRatio + delta / containerWidth))
        setCompareSplitRatio(newRatio)
      })
    }
    const onMouseUp = () => {
      compareDragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [compareSplitRatio, setCompareSplitRatio])

  React.useEffect(() => {
    if (tabs.length > 0 && !activeTabId) {
      setActiveTabId(tabs[0]!.id)
    }
  }, [tabs, activeTabId, setActiveTabId])

  // 左侧容器宽度：Canvas 分屏打开时固定占 splitRatio；其他情况直接占满。
  // 对比态优先接管右 slot：此时不显示 canvas 右面板。
  const showRightPanel = !showComparePane && showCanvasPanel
  const leftFlexStyle: React.CSSProperties = showComparePane
    ? { flex: `0 0 calc(${compareSplitRatio * 100}% - 6px)` }
    : showRightPanel
      ? { flex: `0 0 calc(${splitRatio * 100}% - 6px)` }
      : { flex: '1 1 auto' }

  return (
    <Panel variant="grow" className="bg-content-area">
      <div className="flex flex-1 min-h-0 relative overflow-hidden" data-split-container>
        {/* 左侧：TabBar + TabContent（始终保持在同一 DOM 位置，避免 Tab 切换时 unmount） */}
        <div
          className="flex flex-col min-w-0 h-full relative"
          style={leftFlexStyle}
        >
          {activeView === 'planning' ? (
            automationFormOpen ? <AutomationFormView /> : <PlanningView />
          ) : activeView === 'agent-skills' ? (
            <AgentSkillsView />
          ) : activeView === 'vault' ? (
            <VaultView />
          ) : (
            <>
              {showCenterTabBar && <TabBar />}
              {automationFormOpen && activeView !== 'conversations' ? (
                <AutomationFormView />
              ) : tabs.length === 0 ? (
                <WelcomeView />
              ) : contentTabId ? (
                <div className="flex-1 min-h-0 titlebar-no-drag"><TabContent tabId={contentTabId} /></div>
              ) : null}
            </>
          )}
        </div>

        {/* 右侧：双开对比栏（partner 的 AgentView）。对比态接管右 slot，优先于 canvas。 */}
        {/* 右栏延迟一帧挂载：左栏先渲染完，避免两个重组件同时初始化导致卡顿。 */}
        {showComparePane && comparePartnerId && (
          <>
            <div
              className="w-[8px] cursor-col-resize bg-border/40 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 self-stretch"
              onMouseDown={handleCompareDragStart}
            />
            <div className="flex flex-col min-w-[260px] h-full overflow-hidden" style={{ flex: '1 1 auto' }}>
              {/* 补一条与左栏 TabBar 等高（34px）的顶栏，使右栏 AgentHeader 与左栏对齐 */}
              <div className="h-[34px] tabbar-bg flex-shrink-0" />
              <div className="flex-1 min-h-0">
                {partnerPaneReady ? (
                  <TabErrorBoundary key={comparePartnerId} sessionId={comparePartnerId}>
                    <AgentView sessionId={comparePartnerId} sharedModelSelectorOpen={false} />
                  </TabErrorBoundary>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    <Loader2 className="size-4 animate-spin mr-2" />
                    加载中…
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* 右侧：Canvas 分屏面板（Browser/Preview 已由上游右侧 SidePanel 标签体系承载）。 */}
        {showRightPanel && (
          <>
            <div
              className="w-[8px] cursor-col-resize bg-border/40 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 self-stretch"
              onMouseDown={handleCanvasDragStart}
            />
            <div className="flex flex-col min-w-[280px] h-full overflow-hidden" style={{ flex: '1 1 auto' }}>
              {/* key 按会话 remount：切换 session 时重建干净的 nodes/history/refs/view，
                  避免复用同一实例带旧会话遗留状态（新会话双击建 node 白屏）。
                  TabErrorBoundary：画布渲染异常时降级为错误卡片，不再整树白屏。 */}
              <TabErrorBoundary
                key={canvasPanelSessionId ?? 'canvas-global'}
                sessionId={canvasPanelSessionId ?? 'canvas-global'}
              >
                <CanvasPane
                  sessionId={canvasPanelSessionId ?? undefined}
                  onClose={() => closeCanvasInSplit(store)}
                />
              </TabErrorBoundary>
            </div>
          </>
        )}
      </div>
    </Panel>
  )
}
