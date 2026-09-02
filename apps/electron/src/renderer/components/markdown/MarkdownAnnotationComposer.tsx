/**
 * 批注评论弹层：选中正文后新建，或点击行内 Tag 后编辑/删除。
 * 挂到 body，避免被预览容器的 overflow/transform 裁切。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { MarkdownAnnotationComposerState } from './useMarkdownAnnotations'

export const MARKDOWN_ANNOTATION_COMPOSER_SELECTOR = '[data-markdown-annotation-composer]'

const COMPOSER_WIDTH = 320
const COMPOSER_ESTIMATED_HEIGHT = 190
const EDGE_PADDING = 12

interface MarkdownAnnotationComposerProps {
  state: MarkdownAnnotationComposerState
  onSubmit: (comment: string) => void
  onCancel: () => void
  onDelete?: () => void
}

export function MarkdownAnnotationComposer({ state, onSubmit, onCancel, onDelete }: MarkdownAnnotationComposerProps): React.ReactElement {
  const [comment, setComment] = React.useState(state.initialComment)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    setComment(state.initialComment)
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [state])

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      const card = cardRef.current
      if (card && event.target instanceof Node && card.contains(event.target)) return
      onCancel()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [onCancel])

  const submit = React.useCallback(() => {
    onSubmit(comment.trim())
  }, [comment, onSubmit])

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const left = Math.max(EDGE_PADDING, Math.min(state.x - COMPOSER_WIDTH / 2, viewportWidth - COMPOSER_WIDTH - EDGE_PADDING))
  const openBelow = state.y + COMPOSER_ESTIMATED_HEIGHT + EDGE_PADDING < viewportHeight
  const top = openBelow ? state.y + 8 : Math.max(EDGE_PADDING, state.y - 28)

  const content = (
    <div
      ref={cardRef}
      data-markdown-annotation-composer
      role="dialog"
      aria-label={state.mode === 'create' ? '添加批注' : '编辑批注'}
      className={`fixed z-[95] flex flex-col gap-2 rounded-xl border border-border/50 bg-popover p-3 text-popover-foreground shadow-lg ${openBelow ? '' : '-translate-y-full'}`}
      style={{ left, top, width: COMPOSER_WIDTH }}
    >
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span>{state.mode === 'create' ? '添加批注' : '编辑批注'}</span>
        <span>⌘/Ctrl + Enter 保存 · Esc 取消</span>
      </div>
      <Textarea
        ref={textareaRef}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="写下你对这段内容的意见或疑问"
        rows={3}
        className="min-h-[72px] resize-none text-[13px]"
      />
      <div className="flex items-center justify-between gap-2">
        {state.mode === 'edit' && onDelete ? (
          <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 />
            删除
          </Button>
        ) : <span />}
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button type="button" size="sm" onClick={submit}>{state.mode === 'create' ? '添加' : '保存'}</Button>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
