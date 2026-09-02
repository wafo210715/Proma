/**
 * 批注审阅面板：按文档顺序列出全部批注，勾选后批量发送到 Agent 输入框。
 * 与行内 Tag 共用序号，方便在正文与面板之间对照。
 */

import * as React from 'react'
import { Crosshair, MessageSquareText, Pencil, Send, Trash2, X } from 'lucide-react'
import type { MarkdownAnnotation } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarkdownAnnotationController, MarkdownAnnotationPanelLayout } from './useMarkdownAnnotations'

interface MarkdownAnnotationPanelProps {
  controller: MarkdownAnnotationController
  /** side = 与正文并排；overlay = 浮在正文右侧（容器过窄时） */
  layout?: MarkdownAnnotationPanelLayout
  className?: string
}

function statusLabel(annotation: MarkdownAnnotation): string | null {
  if (annotation.status === 'sent') return '已发送'
  if (annotation.status === 'outdated') return '原文已变更'
  return null
}

function lineLabel(annotation: MarkdownAnnotation): string {
  const { startLine, endLine } = annotation.anchor
  return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`
}

function excerpt(text: string, maxChars = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(single)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : single
}

export function MarkdownAnnotationPanel({ controller, layout = 'side', className }: MarkdownAnnotationPanelProps): React.ReactElement {
  const { annotations, numbers, canSendToAgent } = controller
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set())

  // 批注被删除或已发送后自动取消勾选，避免重复发送。
  React.useEffect(() => {
    setChecked((previous) => {
      const alive = new Set(annotations.filter((item) => item.status !== 'sent').map((item) => item.id))
      let changed = false
      const next = new Set<string>()
      for (const id of previous) {
        if (alive.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : previous
    })
  }, [annotations])

  const selectable = annotations.filter((item) => item.status !== 'sent')
  const allChecked = selectable.length > 0 && selectable.every((item) => checked.has(item.id))
  const sentCount = annotations.filter((item) => item.status === 'sent').length

  const toggleAll = (): void => {
    setChecked(allChecked ? new Set() : new Set(selectable.map((item) => item.id)))
  }

  const toggleOne = (id: string): void => {
    setChecked((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSend = (): void => {
    if (checked.size === 0) return
    if (controller.sendToAgent(checked)) setChecked(new Set())
  }

  return (
    <aside
      aria-label="批注面板"
      className={cn(
        'flex w-64 flex-col border-l border-border/60 bg-background/85 backdrop-blur-sm',
        layout === 'overlay' ? 'absolute inset-y-0 right-0 z-20 max-w-[85%] shadow-xl' : 'max-w-[50%] shrink-0',
        className,
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[12px] font-medium text-foreground/80">
        <MessageSquareText className="size-3.5 text-foreground/50" />
        <span>批注</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{annotations.length}</span>
        <button
          type="button"
          onClick={() => controller.setPanelOpen(false)}
          className="ml-auto rounded p-1 text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70"
          aria-label="隐藏批注面板"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {annotations.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-muted-foreground">
            选中正文后点「添加批注」，批注会留在原文行间；通读完再在这里勾选，一起发给 Agent。
          </p>
        ) : (
          <ul className="flex flex-col">
            {annotations.map((annotation) => {
              const number = numbers.get(annotation.id)
              const label = statusLabel(annotation)
              const isSent = annotation.status === 'sent'
              const checkboxId = `markdown-annotation-${annotation.id}`
              return (
                <li
                  key={annotation.id}
                  className={cn('group/annotation border-b border-border/40 px-3 py-2.5 transition-colors hover:bg-muted/40', isSent && 'opacity-60')}
                >
                  <div className="flex items-start gap-2">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className="mt-1 size-3.5 shrink-0 accent-primary"
                      checked={checked.has(annotation.id)}
                      onChange={() => toggleOne(annotation.id)}
                      aria-label={`选择批注 ${number ?? ''}`}
                    />
                    <span
                      className={cn(
                        'mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
                        number === null ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground',
                      )}
                    >
                      {number ?? '!'}
                    </span>
                    <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                      <p className="border-l-2 border-primary/30 pl-2 text-[12px] leading-snug text-muted-foreground line-clamp-2 break-words [overflow-wrap:anywhere]">
                        {excerpt(annotation.anchor.exact)}
                      </p>
                      <p className={cn('mt-1 text-[13px] leading-snug break-words [overflow-wrap:anywhere]', !annotation.comment.trim() && 'italic text-muted-foreground')}>
                        {annotation.comment.trim() || '（未填写评论）'}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {lineLabel(annotation)}
                        {label && <span className={cn('ml-1.5', annotation.status === 'outdated' && 'text-amber-600 dark:text-amber-400')}>· {label}</span>}
                      </p>
                    </label>
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/annotation:opacity-100 focus-within:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => controller.jumpToAnnotation(annotation.id)}
                          className="rounded p-1 text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70"
                          aria-label="定位到原文"
                        >
                          <Crosshair className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">定位到原文</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            controller.openComposerForAnnotation(annotation.id, rect.left, rect.bottom + 6)
                          }}
                          className="rounded p-1 text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70"
                          aria-label="编辑评论"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">编辑评论</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => controller.removeAnnotation(annotation.id)}
                          className="rounded p-1 text-foreground/40 hover:bg-destructive/10 hover:text-destructive"
                          aria-label="删除批注"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">删除批注</TooltipContent>
                    </Tooltip>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-3 py-2.5">
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={allChecked}
              disabled={selectable.length === 0}
              onChange={toggleAll}
              aria-label="全选未发送批注"
            />
            全选
            {selectable.length > 0 && <span className="tabular-nums">（{checked.size}/{selectable.length}）</span>}
          </label>
          {sentCount > 0 && (
            <button
              type="button"
              onClick={controller.clearSent}
              className="rounded px-1.5 py-0.5 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              清除已发送
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-full">
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={checked.size === 0 || !canSendToAgent}
                onClick={handleSend}
              >
                <Send />
                发送到输入框{checked.size > 0 ? `（${checked.size}）` : ''}
              </Button>
            </span>
          </TooltipTrigger>
          {!canSendToAgent && <TooltipContent side="top">请从 Agent 会话右侧打开此文件后再发送</TooltipContent>}
        </Tooltip>
      </div>
    </aside>
  )
}
