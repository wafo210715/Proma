/**
 * QuotedSelectionChip — 引用选中文本的 Chip 标签
 *
 * 显示在 Chat 输入框上方，展示预览面板 / Vault 中选中的文本及来源。
 * 正文全量展示（保留换行），超长时在 chip 内部滚动；来源行带字符数，
 * 让用户能确认引用内容完整（字数为码点口径，与发送内容一致）。
 */

import * as React from 'react'
import { X, Quote } from 'lucide-react'
import { cn } from '@/lib/utils'

interface QuotedSelectionChipProps {
  /** 选中的文本（完整内容） */
  text: string
  /** 来源文件路径（截断显示） */
  filePath: string
  /** 来源展示名称 */
  sourceLabel?: string
  /** 移除回调 */
  onRemove: () => void
  className?: string
}

function truncatePath(filePath: string, maxLen: number = 40): string {
  if (filePath.length <= maxLen) return filePath
  const name = filePath.split('/').pop() ?? filePath
  return '.../' + name
}

export function QuotedSelectionChip({
  text,
  filePath,
  sourceLabel,
  onRemove,
  className,
}: QuotedSelectionChipProps): React.ReactElement {
  const handleRemoveClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onRemove()
  }, [onRemove])

  // 码点口径与 lib/quoted-selection 的 label 保持一致（emoji 计 1）。
  const charCount = React.useMemo(() => Array.from(text).length, [text])

  return (
    <div
      className={cn(
        'group/chip relative flex min-w-0 max-w-full items-start gap-2',
        'rounded-lg bg-primary/8 border border-primary/20',
        'pl-2.5 pr-7 py-1.5 text-[13px]',
        'transition-colors hover:bg-primary/12',
        className,
      )}
    >
      <Quote className="size-4 shrink-0 mt-0.5 text-primary/60" />
      <div className="flex flex-col min-w-0">
        <span className="whitespace-pre-wrap break-words leading-snug [overflow-wrap:anywhere] max-h-[160px] overflow-y-auto scrollbar-thin text-foreground/80">
          {text}
        </span>
        <span className="text-[11px] text-muted-foreground/60 mt-0.5 break-words [overflow-wrap:anywhere]">
          {(sourceLabel ?? truncatePath(filePath)) + ` · ${charCount} 字`}
        </span>
      </div>
      <button
        type="button"
        onClick={handleRemoveClick}
        className={cn(
          'absolute top-1 right-1 size-[18px] rounded-full',
          'bg-foreground/10 text-foreground/50',
          'flex items-center justify-center',
          'opacity-0 group-hover/chip:opacity-100 transition-opacity duration-200',
          'hover:bg-foreground/20 hover:text-foreground',
        )}
        aria-label="移除引用"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
