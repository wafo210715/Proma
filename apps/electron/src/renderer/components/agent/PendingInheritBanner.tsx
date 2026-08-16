/**
 * PendingInheritBanner — 待办·继承上下文提示条
 *
 * 当源会话正在跑、用户点了「新建并继承上下文」时，把意图记为待办（pendingInheritAtom）。
 * 本 banner 在源会话输入框上方持续显示，直到源会话这轮跑完由 watcher 执行、或用户手动取消。
 * 风格参照 AgentMessageQueue 的轻量条目。
 */

import * as React from 'react'
import { Clock3, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PendingInheritBannerProps {
  /** 目标模型显示名（channel/model），用于提示用户将继承到哪个模型 */
  targetLabel: string
  onCancel: () => void
}

export function PendingInheritBanner({ targetLabel, onCancel }: PendingInheritBannerProps): React.ReactElement {
  return (
    <div
      className={cn(
        'mx-2 mt-2 mb-1 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5',
        'text-xs text-foreground/80',
      )}
    >
      <Clock3 className="size-3.5 flex-shrink-0 text-primary/70" />
      <span className="flex-1 truncate">
        待办·继承上下文到 <span className="font-medium">{targetLabel}</span>：本轮完成后自动建好对比会话
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        aria-label="取消待办继承"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
