/**
 * Markdown 批注控制器：加载/注水/持久化 + 增删改 + 批量发送到 Agent 输入框。
 *
 * 普通 .md 预览与 Vault 预览各调用一次，UI（评论弹层、审阅面板）由宿主按各自布局挂载。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { MarkdownAnnotation, MarkdownAnnotationTarget } from '@proma/shared'
import { markdownAnnotationsAtomFamily } from '@/atoms/markdown-annotation-atoms'
import { useFocusAgentSessionInput } from '@/hooks/useFocusAgentSessionInput'
import { insertAgentInputQuote } from '@/lib/agent-input-quote'
import {
  areMarkdownAnnotationListsEqual,
  buildMarkdownAnnotationDraftText,
  buildMarkdownAnnotationQuote,
  createMarkdownAnnotationAnchor,
  getMarkdownAnnotationFileKey,
  numberMarkdownAnnotations,
  sortMarkdownAnnotations,
} from '@/lib/markdown-annotations'
import {
  createLiveMarkdownAnnotations,
  getLiveMarkdownAnnotations,
  setLiveMarkdownAnnotationsEffect,
  type LiveMarkdownAnnotationCallbacks,
} from './live-markdown-annotations'

const SAVE_DEBOUNCE_MS = 400

export interface MarkdownAnnotationRange {
  from: number
  to: number
}

export interface MarkdownAnnotationComposerState {
  mode: 'create' | 'edit'
  annotationId?: string
  range?: MarkdownAnnotationRange
  /** 视口坐标（弹层锚点） */
  x: number
  y: number
  initialComment: string
}

export interface UseMarkdownAnnotationsOptions {
  /** 当前文件；null 表示该表面暂不支持批注（如非 Markdown）。 */
  target: MarkdownAnnotationTarget | null
  /** 引用块里的路径（文件用绝对路径，Vault 用相对路径，与既有「为 Agent 引用」一致） */
  quoteFilePath: string
  quoteSourceLabel?: string
  /** 发送目标会话；独立 Vault Tab 没有会话时只能批注不能发送 */
  sessionId?: string
  getView: () => EditorView | null
  /** 编辑器实例就绪标记；变化时重新向 CodeMirror 注水 */
  editorReadyKey: string | number | null
  scrollToPosition: (position: number) => void
}

export interface MarkdownAnnotationController {
  enabled: boolean
  loaded: boolean
  /** 文档顺序排序后的批注 */
  annotations: MarkdownAnnotation[]
  numbers: Map<string, number | null>
  extension: Extension
  composer: MarkdownAnnotationComposerState | null
  openComposerForRange: (range: MarkdownAnnotationRange, x: number, y: number) => void
  openComposerForAnnotation: (annotationId: string, x: number, y: number) => void
  closeComposer: () => void
  submitComposer: (comment: string) => void
  removeAnnotation: (annotationId: string) => void
  jumpToAnnotation: (annotationId: string) => void
  clearSent: () => void
  /** 勾选的批注依次插入输入框（引文 chip + 评论），成功后标记 sent。 */
  sendToAgent: (annotationIds: Iterable<string>) => boolean
  canSendToAgent: boolean
  panelOpen: boolean
  setPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
}

const EMPTY_ANNOTATIONS: MarkdownAnnotation[] = []

export function useMarkdownAnnotations({
  target,
  quoteFilePath,
  quoteSourceLabel,
  sessionId,
  getView,
  editorReadyKey,
  scrollToPosition,
}: UseMarkdownAnnotationsOptions): MarkdownAnnotationController {
  const fileKey = target ? getMarkdownAnnotationFileKey(target) : ''
  const [stored, setStored] = useAtom(markdownAnnotationsAtomFamily(fileKey))
  const [loaded, setLoaded] = React.useState(false)
  const [composer, setComposer] = React.useState<MarkdownAnnotationComposerState | null>(null)
  const [panelOpen, setPanelOpen] = React.useState(false)
  const focusAgentSessionInput = useFocusAgentSessionInput()

  const targetRef = React.useRef(target)
  targetRef.current = target
  const storedRef = React.useRef(stored)
  storedRef.current = stored
  const getViewRef = React.useRef(getView)
  getViewRef.current = getView
  const lastSavedRef = React.useRef<MarkdownAnnotation[] | null>(null)
  const pendingSaveRef = React.useRef<{ timer: number; flush: () => void } | null>(null)

  const sorted = React.useMemo(() => (stored ? sortMarkdownAnnotations(stored) : EMPTY_ANNOTATIONS), [stored])
  const numbers = React.useMemo(() => numberMarkdownAnnotations(sorted), [sorted])

  const openComposerForAnnotation = React.useCallback((annotationId: string, x: number, y: number) => {
    const annotation = storedRef.current?.find((item) => item.id === annotationId)
    if (!annotation) return
    setComposer({ mode: 'edit', annotationId, x, y, initialComment: annotation.comment })
  }, [])

  // CodeMirror 扩展在编辑器生命周期内只创建一次；回调经 ref 取最新值。
  const callbacksRef = React.useRef<LiveMarkdownAnnotationCallbacks>({ onTagClick: () => {}, onAnnotationsMapped: () => {} })
  callbacksRef.current = {
    onTagClick: (annotationId, rect) => openComposerForAnnotation(annotationId, rect.left + rect.width / 2, rect.bottom + 6),
    onAnnotationsMapped: (annotations) => {
      if (!targetRef.current) return
      setStored((previous) => (previous && areMarkdownAnnotationListsEqual(previous, annotations) ? previous : annotations))
    },
  }
  const [extension] = React.useState<Extension>(() => createLiveMarkdownAnnotations(() => callbacksRef.current))

  // 切换文件：从 sidecar 读取；读取失败降级为空列表并提示，不阻塞预览。
  React.useEffect(() => {
    setComposer(null)
    if (!fileKey || !targetRef.current) {
      setLoaded(false)
      return
    }
    let cancelled = false
    setLoaded(false)
    lastSavedRef.current = null
    window.electronAPI.loadMarkdownAnnotations(targetRef.current)
      .then((annotations) => {
        if (cancelled) return
        lastSavedRef.current = annotations
        setStored(annotations)
        setLoaded(true)
      })
      .catch((error: unknown) => {
        console.error('[MarkdownAnnotations] 读取批注失败:', error)
        if (cancelled) return
        toast.error('读取批注失败，本次批注不会保存')
        lastSavedRef.current = []
        setStored([])
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [fileKey, setStored])

  // 注水：atom 变化或编辑器重建后，把批注同步进 CodeMirror（扩展内会按当前文档重定位）。
  React.useEffect(() => {
    if (!loaded || !stored) return
    const view = getViewRef.current()
    if (!view) return
    if (areMarkdownAnnotationListsEqual(getLiveMarkdownAnnotations(view.state), stored)) return
    view.dispatch({ effects: setLiveMarkdownAnnotationsEffect.of(stored) })
    const relocated = getLiveMarkdownAnnotations(view.state)
    if (!areMarkdownAnnotationListsEqual(relocated, stored)) setStored([...relocated])
  }, [editorReadyKey, loaded, setStored, stored])

  // 持久化：任何变化（含编辑导致的锚点平移）防抖写回；切换文件或卸载时立即冲刷。
  React.useEffect(() => {
    if (!loaded || !stored || stored === lastSavedRef.current) return
    const currentTarget = targetRef.current
    if (!currentTarget) return
    if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current.timer)
    const flush = (): void => {
      pendingSaveRef.current = null
      lastSavedRef.current = stored
      window.electronAPI.saveMarkdownAnnotations({ target: currentTarget, annotations: stored })
        .catch((error: unknown) => {
          console.error('[MarkdownAnnotations] 保存批注失败:', error)
          toast.error('保存批注失败')
        })
    }
    const timer = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    pendingSaveRef.current = { timer, flush }
  }, [loaded, stored])

  React.useEffect(() => () => {
    const pending = pendingSaveRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pending.flush()
  }, [fileKey])

  const openComposerForRange = React.useCallback((range: MarkdownAnnotationRange, x: number, y: number) => {
    if (!targetRef.current) return
    setComposer({ mode: 'create', range, x, y, initialComment: '' })
  }, [])

  const closeComposer = React.useCallback(() => setComposer(null), [])

  const submitComposer = React.useCallback((comment: string) => {
    const current = composer
    if (!current) return
    const now = Date.now()
    if (current.mode === 'edit' && current.annotationId) {
      const annotationId = current.annotationId
      setStored((previous) => (previous ?? []).map((item) => (
        item.id === annotationId ? { ...item, comment, updatedAt: now } : item
      )))
      setComposer(null)
      return
    }
    const view = getViewRef.current()
    if (!view || !current.range) {
      toast.error('编辑器尚未就绪，无法添加批注')
      return
    }
    const anchor = createMarkdownAnnotationAnchor(view.state.doc, current.range.from, current.range.to)
    if (!anchor.exact.trim()) {
      toast.info('请先选中要批注的正文')
      setComposer(null)
      return
    }
    const annotation: MarkdownAnnotation = {
      id: crypto.randomUUID(),
      anchor,
      comment,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    setStored((previous) => [...(previous ?? []), annotation])
    setPanelOpen(true)
    setComposer(null)
  }, [composer, setStored])

  const removeAnnotation = React.useCallback((annotationId: string) => {
    setStored((previous) => (previous ?? []).filter((item) => item.id !== annotationId))
    setComposer((current) => (current?.annotationId === annotationId ? null : current))
  }, [setStored])

  const jumpToAnnotation = React.useCallback((annotationId: string) => {
    const annotation = storedRef.current?.find((item) => item.id === annotationId)
    if (!annotation) return
    if (annotation.status === 'outdated') {
      toast.info('原文已变更，无法定位到这条批注')
      return
    }
    scrollToPosition(annotation.anchor.from)
  }, [scrollToPosition])

  const clearSent = React.useCallback(() => {
    setStored((previous) => (previous ?? []).filter((item) => item.status !== 'sent'))
  }, [setStored])

  const canSendToAgent = Boolean(sessionId)

  const sendToAgent = React.useCallback((annotationIds: Iterable<string>): boolean => {
    if (!sessionId) {
      toast.info('请从 Agent 会话右侧打开此文件后再发送批注')
      return false
    }
    const wanted = new Set(annotationIds)
    const selected = sortMarkdownAnnotations(storedRef.current ?? []).filter((item) => wanted.has(item.id))
    if (selected.length === 0) return false
    const sentIds: string[] = []
    for (const annotation of selected) {
      const quote = buildMarkdownAnnotationQuote(annotation, quoteFilePath, quoteSourceLabel, annotation.createdAt)
      const inserted = insertAgentInputQuote(sessionId, quote, {
        trailingText: buildMarkdownAnnotationDraftText(annotation),
        lineBreak: true,
      })
      if (!inserted) break
      sentIds.push(annotation.id)
    }
    if (sentIds.length === 0) {
      toast.error('目标会话的输入框不可用，请先打开该 Agent 会话')
      return false
    }
    const now = Date.now()
    const sentSet = new Set(sentIds)
    setStored((previous) => (previous ?? []).map((item) => (
      sentSet.has(item.id) && item.status !== 'sent' ? { ...item, status: 'sent', updatedAt: now } : item
    )))
    if (sentIds.length < selected.length) {
      toast.warning(`仅 ${sentIds.length}/${selected.length} 条批注进入输入框`)
    } else {
      toast.success(`已将 ${sentIds.length} 条批注放入输入框`)
    }
    focusAgentSessionInput(sessionId)
    return true
  }, [focusAgentSessionInput, quoteFilePath, quoteSourceLabel, sessionId, setStored])

  return {
    enabled: Boolean(target),
    loaded,
    annotations: sorted,
    numbers,
    extension,
    composer,
    openComposerForRange,
    openComposerForAnnotation,
    closeComposer,
    submitComposer,
    removeAnnotation,
    jumpToAnnotation,
    clearSent,
    sendToAgent,
    canSendToAgent,
    panelOpen,
    setPanelOpen,
  }
}

export type MarkdownAnnotationPanelLayout = 'side' | 'overlay'

/** 容器宽度不足以并排放下正文与面板时（右侧工作区常见），改为浮层覆盖在正文右侧。 */
const SIDE_PANEL_MIN_CONTAINER_WIDTH = 640

export function useMarkdownAnnotationPanelLayout(containerRef: React.RefObject<HTMLElement | null>): MarkdownAnnotationPanelLayout {
  const [layout, setLayout] = React.useState<MarkdownAnnotationPanelLayout>('side')
  React.useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = (): void => {
      setLayout(element.getBoundingClientRect().width < SIDE_PANEL_MIN_CONTAINER_WIDTH ? 'overlay' : 'side')
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [containerRef])
  return layout
}
