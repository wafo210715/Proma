/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题；通过标题下拉菜单进入重命名。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Check, X, ChevronDown, Columns2, Link2, Link2Off, PanelRight, Split } from 'lucide-react'
import { agentSessionsAtom, agentSessionStreamingStateAtomFamily, agentSideTemporaryAgentMapAtom, agentDiffPanelTabAtom, currentSessionSidePanelOpenAtom, getExplorationSidePanelTab } from '@/atoms/agent-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { comparePairsAtom, compareLinkedAtom, getComparePartner, removePairContaining, addPair } from '@/atoms/compare-atoms'
import { useCompareActions } from '@/hooks/useCompareActions'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ModelOption } from '@proma/shared'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** AgentHeader 属性接口 */
interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId) ?? null
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setSideTemporaryAgentMap = useSetAtom(agentSideTemporaryAgentMapAtom)
  const setSidePanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const [isRightPanelOpen, setRightPanelOpen] = useAtom(currentSessionSidePanelOpenAtom)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 双开对比控件状态
  const [comparePairs, setComparePairs] = useAtom(comparePairsAtom)
  const [compareLinked, setCompareLinked] = useAtom(compareLinkedAtom)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const comparePartnerId = getComparePartner(comparePairs, sessionId)
  const inComparePair = comparePartnerId !== null
  const otherSessions = sessions.filter((s) => s.id !== sessionId)
  const { requestInherit } = useCompareActions()
  // 源会话是否正在跑：继承上下文时用于决定「立即执行」还是「变待办等这轮结束」
  const srcStreaming = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const sourceRunning = !!srcStreaming?.running

  /** 新建并继承上下文：用户在模型选择器里选定目标模型后触发 */
  const handleInheritWithModel = React.useCallback(async (option: ModelOption): Promise<void> => {
    if (!session) return
    setPickerOpen(false)
    await requestInherit(session, option.channelId, option.modelId, sourceRunning)
  }, [session, requestInherit, sourceRunning])

  const explorationBranches = React.useMemo(() => sessions
    .filter((item) => item.explorationParentSessionId === sessionId && item.explorationSourceMessageId)
    .sort((a, b) => b.updatedAt - a.updatedAt), [sessionId, sessions])

  const reopenExploration = React.useCallback((branch: typeof explorationBranches[number]): void => {
    const sourceMessageId = branch.explorationSourceMessageId
    if (!sourceMessageId) return
    setSideTemporaryAgentMap((prev) => {
      const openBranches = prev.get(sessionId) ?? []
      if (openBranches.some((item) => item.sessionId === branch.id)) return prev
      const next = new Map(prev)
      next.set(sessionId, [...openBranches, {
        sessionId: branch.id,
        sourceMessageId,
        sourceLabel: branch.explorationSourceLabel || '主线探索节点',
      }])
      return next
    })
    setRightPanelOpen(true)
    setSidePanelTabMap((prev) => new Map(prev).set(sessionId, getExplorationSidePanelTab(branch.id)))
  }, [sessionId, setRightPanelOpen, setSidePanelTabMap, setSideTemporaryAgentMap])

  if (!session) return null

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, trimmed)
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
      // 同步更新侧边栏会话列表
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
    }
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div className="relative z-[51] flex items-center gap-2 px-3 h-[48px]">
      {/* 页面标题栏仍可拖动；系统控制按钮由窗口顶部的统一标题栏承载。 */}
      <div className="absolute inset-0 titlebar-drag-region pointer-events-none" />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="flex-1 bg-transparent text-[15px] font-normal border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60"
              aria-label={`会话菜单：${session.title}`}
            >
              <span className="truncate text-[15px] font-normal text-foreground">{session.title}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[100] min-w-40 titlebar-no-drag">
            <DropdownMenuItem onSelect={startEdit}>
              <Pencil className="size-3.5" />
              重命名
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {explorationBranches.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
              aria-label={`打开 ${explorationBranches.length} 个探索分支`}
              title={`打开探索分支（${explorationBranches.length}）`}
            >
              <Split className="size-3.5" />
              <span className="hidden sm:inline">探索</span>
              {explorationBranches.length > 1 && <span className="tabular-nums">{explorationBranches.length}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="z-[100] w-64 titlebar-no-drag"
            // 选择或失焦关闭后不要把焦点回跳到「探索」触发器，避免出现残留 focus 框。
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {explorationBranches.map((branch) => (
              <DropdownMenuItem key={branch.id} onSelect={() => reopenExploration(branch)} className="flex items-center gap-2 py-2">
                <Split className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{branch.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!isRightPanelOpen && (
        <button
          type="button"
          onClick={() => setRightPanelOpen(true)}
          className="titlebar-no-drag ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
          aria-label="展开右侧工作区"
        >
          <PanelRight className="size-4" />
        </button>
      )}

        {inComparePair ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setCompareLinked((v) => !v)}
                  className={cn(
                    'titlebar-no-drag p-1 transition-colors',
                    compareLinked
                      ? 'text-primary hover:text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-label={compareLinked ? '联动已开启' : '联动已关闭'}
                >
                  {compareLinked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{compareLinked ? '联动开启：一个 prompt 注入两个 session' : '联动关闭：两侧各聊各的'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setComparePairs((prev) => removePairContaining(prev, sessionId))}
                  className="titlebar-no-drag p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="解绑分屏对比"
                >
                  <X className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>解绑分屏对比</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="titlebar-no-drag p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                aria-label="分屏对比"
                title="分屏对比：选择另一个 session 并排"
              >
                <Columns2 className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1">
              {/* 新建并继承当前上下文：选目标模型 → 同渠道 fork / 跨渠道注入；源会话在跑则变待办 */}
              <div className="px-2 py-1.5">
                <div className="mb-1 text-xs text-muted-foreground">
                  新建并继承上下文{sourceRunning ? '（左侧在跑，将等这轮结束）' : ''}
                </div>
                <ModelSelector
                  externalSelectedModel={
                    session.channelId && session.modelId
                      ? { channelId: session.channelId, modelId: session.modelId }
                      : null
                  }
                  onModelSelect={(option) => { void handleInheritWithModel(option) }}
                  showChannelInTrigger
                />
              </div>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-xs text-muted-foreground">或选择已有 session 并排</div>
              {otherSessions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">暂无其它 session</div>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {otherSessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setComparePairs((prev) => addPair(prev, sessionId, s.id))
                        setCompareLinked(true)
                        setPickerOpen(false)
                      }}
                      className="w-full text-left px-2 py-1.5 rounded text-sm text-foreground hover:bg-muted transition-colors truncate"
                    >
                      {s.title || '未命名 session'}
                    </button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}
    </div>
  )
}
