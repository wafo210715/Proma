/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题（可点击编辑）。
 * 参照 ChatHeader 的编辑模式。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Check, X, Columns2, Link2, Link2Off, Plus } from 'lucide-react'
import type { ModelOption } from '@proma/shared'
import { agentSessionsAtom, agentSessionStreamingStateAtomFamily } from '@/atoms/agent-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { comparePairsAtom, compareLinkedAtom, getComparePartner, removePairContaining } from '@/atoms/compare-atoms'
import { useCompareActions } from '@/hooks/useCompareActions'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** AgentHeader 属性接口 */
interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId) ?? null
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 双开对比控件状态
  const [comparePairs, setComparePairs] = useAtom(comparePairsAtom)
  const [compareLinked, setCompareLinked] = useAtom(compareLinkedAtom)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [creatingCompare, setCreatingCompare] = React.useState(false)
  const comparePartnerId = getComparePartner(comparePairs, sessionId)
  const inComparePair = comparePartnerId !== null
  const otherSessions = sessions.filter((s) => s.id !== sessionId)
  const { createBlankCompare, requestInherit } = useCompareActions()
  // 源会话是否正在跑：继承上下文时用于决定「立即执行」还是「变待办等这轮结束」
  const srcStreaming = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const sourceRunning = !!srcStreaming?.running

  /** 新建空白会话并对比 */
  const handleCreateBlank = React.useCallback(async (): Promise<void> => {
    if (creatingCompare || !session) return
    setCreatingCompare(true)
    try {
      await createBlankCompare(session)
      setPickerOpen(false)
    } finally {
      setCreatingCompare(false)
    }
  }, [creatingCompare, session, createBlankCompare])

  /** 新建并继承上下文：用户在模型选择器里选定目标模型后触发 */
  const handleInheritWithModel = React.useCallback(async (option: ModelOption): Promise<void> => {
    if (!session) return
    setPickerOpen(false)
    await requestInherit(session, option.channelId, option.modelId, sourceRunning)
  }, [session, requestInherit, sourceRunning])

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
    <div className="relative z-[51] flex items-center gap-2 px-4 h-[48px]">
      {/* 拖拽层覆盖整行（Windows 避开右上角 WindowControls ~126px），编辑/标题按钮内部已自带 titlebar-no-drag。 */}
      <div className={cn("absolute inset-0 titlebar-drag-region pointer-events-none", isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="flex-1 bg-transparent text-sm font-medium border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
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
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="truncate text-sm font-medium text-foreground">
            {session.title}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startEdit}
            className="titlebar-no-drag p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="编辑标题"
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
      )}

      {/* 双开对比控件：未配对显示「分屏对比」按钮；已配对显示联动开关 + 解绑 */}
      <div className="titlebar-no-drag flex items-center gap-1 flex-shrink-0">
        {inComparePair ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setCompareLinked((v) => !v)}
                  className={cn(
                    'p-1.5 rounded-md transition-colors',
                    compareLinked
                      ? 'text-primary bg-primary/10 hover:bg-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
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
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="分屏对比"
                title="分屏对比：选择另一个 session 并排"
              >
                <Columns2 className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1">
              {/* 新建空白会话并对比（pin 到源会话模型，右栏可自行改） */}
              <button
                type="button"
                disabled={creatingCompare}
                onClick={() => { void handleCreateBlank() }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                <Plus className="size-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">新建空白会话并对比</span>
              </button>
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
                        setComparePairs((prev) => {
                          const filtered = prev.filter(
                            (p) => p.left !== sessionId && p.left !== s.id && p.right !== sessionId && p.right !== s.id,
                          )
                          return [...filtered, { left: sessionId, right: s.id }]
                        })
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
    </div>
  )
}
