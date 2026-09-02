/**
 * Markdown 批注的 CodeMirror 扩展：一份实现，普通 .md 预览与 Vault 预览各挂一次。
 *
 * - StateField 持有批注列表，随文档编辑用 change mapping 平移锚点（整文替换走重定位）；
 * - 被批注文本用 mark 装饰淡淡高亮，末尾追加序号 Tag（inline widget，随折行自然换行，不遮挡正文）；
 * - Tag 是真实 <button>，点击交给 React 层弹出评论编辑框。
 */

import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { MarkdownAnnotation } from '@proma/shared'
import {
  areMarkdownAnnotationListsEqual,
  mapMarkdownAnnotationsThroughChanges,
  numberMarkdownAnnotations,
  relocateMarkdownAnnotation,
  sortMarkdownAnnotations,
  summarizeMarkdownAnnotation,
} from '@/lib/markdown-annotations'

export interface LiveMarkdownAnnotationCallbacks {
  /** 用户点击行内 Tag；rect 为 Tag 的视口矩形，用于定位评论弹层。 */
  onTagClick: (annotationId: string, rect: DOMRect) => void
  /** 文档编辑导致锚点平移或失效后回写给 React 层（回调内不要同步 dispatch）。 */
  onAnnotationsMapped: (annotations: MarkdownAnnotation[]) => void
}

type GetCallbacks = () => LiveMarkdownAnnotationCallbacks

interface AnnotationState {
  annotations: MarkdownAnnotation[]
  decorations: DecorationSet
}

const noopCallbacks: LiveMarkdownAnnotationCallbacks = {
  onTagClick: () => {},
  onAnnotationsMapped: () => {},
}

/** 宿主通过 ref 提供最新回调；扩展在编辑器生命周期内只创建一次。 */
const annotationCallbacks = Facet.define<GetCallbacks, GetCallbacks>({
  combine: (values) => values[0] ?? (() => noopCallbacks),
})

/** React 层注水或增删改批注时派发；扩展会先按当前文档重定位再落入状态。 */
export const setLiveMarkdownAnnotationsEffect = StateEffect.define<readonly MarkdownAnnotation[]>()

class AnnotationTagWidget extends WidgetType {
  constructor(
    private readonly annotation: MarkdownAnnotation,
    private readonly index: number,
    private readonly getCallbacks: GetCallbacks,
  ) {
    super()
  }

  override eq(other: AnnotationTagWidget): boolean {
    return other.annotation.id === this.annotation.id
      && other.index === this.index
      && other.annotation.status === this.annotation.status
      && other.annotation.comment === this.annotation.comment
  }

  override toDOM(): HTMLElement {
    const button = document.createElement('button')
    const summary = summarizeMarkdownAnnotation(this.annotation)
    button.type = 'button'
    button.className = 'live-markdown-annotation-tag'
    button.dataset.annotationId = this.annotation.id
    button.dataset.annotationStatus = this.annotation.status
    button.title = summary
    button.setAttribute('aria-label', `批注 ${this.index}：${summary}`)
    button.textContent = String(this.index)
    // 阻止 contenteditable 把点击当作光标定位，保持编辑器选区与焦点不变。
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.getCallbacks().onTagClick(this.annotation.id, button.getBoundingClientRect())
    })
    return button
  }

  override ignoreEvent(): boolean { return true }
}

function buildAnnotationDecorations(state: EditorState, annotations: readonly MarkdownAnnotation[]): DecorationSet {
  const getCallbacks = state.facet(annotationCallbacks)
  const sorted = sortMarkdownAnnotations(annotations)
  const numbers = numberMarkdownAnnotations(sorted)
  const ranges: Range<Decoration>[] = []
  for (const annotation of sorted) {
    const index = numbers.get(annotation.id)
    if (index === null || index === undefined) continue
    const from = Math.max(0, Math.min(annotation.anchor.from, state.doc.length))
    const to = Math.max(from, Math.min(annotation.anchor.to, state.doc.length))
    if (to > from) {
      ranges.push(Decoration.mark({
        class: 'live-markdown-annotation-range',
        attributes: { 'data-annotation-status': annotation.status },
      }).range(from, to))
    }
    ranges.push(Decoration.widget({
      widget: new AnnotationTagWidget(annotation, index, getCallbacks),
      side: 1,
    }).range(to))
  }
  return Decoration.set(ranges, true)
}

const annotationField = StateField.define<AnnotationState>({
  create: () => ({ annotations: [], decorations: Decoration.none }),
  update: (value, transaction) => {
    let annotations = value.annotations
    let replaced = false
    for (const effect of transaction.effects) {
      if (!effect.is(setLiveMarkdownAnnotationsEffect)) continue
      annotations = effect.value.map((annotation) => relocateMarkdownAnnotation(transaction.state.doc, annotation))
      replaced = true
    }
    if (!replaced && transaction.docChanged) {
      annotations = mapMarkdownAnnotationsThroughChanges(
        annotations,
        transaction.changes,
        transaction.startState.doc.length,
        transaction.state.doc,
      )
    }
    if (!replaced && !transaction.docChanged) return value
    if (replaced && areMarkdownAnnotationListsEqual(annotations, value.annotations)) return value
    return {
      annotations: areMarkdownAnnotationListsEqual(annotations, value.annotations) ? value.annotations : annotations,
      // 文档变了就必须重建装饰：即使锚点内容相同，装饰位置也要跟随新文档。
      decorations: buildAnnotationDecorations(transaction.state, annotations),
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** 读取编辑器内当前批注（含已平移的锚点）。 */
export function getLiveMarkdownAnnotations(state: EditorState): readonly MarkdownAnnotation[] {
  return state.field(annotationField, false)?.annotations ?? []
}

/** 锚点被编辑平移或失效时通知宿主，宿主更新 atom 并持久化。 */
const annotationMappingReporter = ViewPlugin.define(() => ({
  update: (update: ViewUpdate) => {
    if (!update.docChanged) return
    const before = update.startState.field(annotationField, false)?.annotations ?? []
    const after = update.state.field(annotationField, false)?.annotations ?? []
    if (before === after || areMarkdownAnnotationListsEqual(before, after)) return
    update.state.facet(annotationCallbacks)().onAnnotationsMapped(after)
  },
}))

export function createLiveMarkdownAnnotations(getCallbacks: GetCallbacks): Extension {
  return [annotationCallbacks.of(getCallbacks), annotationField, annotationMappingReporter]
}
