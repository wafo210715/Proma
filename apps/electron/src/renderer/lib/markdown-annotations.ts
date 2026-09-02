/**
 * Markdown 批注的纯逻辑：锚点创建、随编辑映射、跨会话重定位、发送时转引用。
 *
 * 只依赖 @codemirror/state 的文档模型，不触碰 DOM，便于在 bun test 中覆盖。
 */

import { MapMode, type ChangeDesc, type Text } from '@codemirror/state'
import type { MarkdownAnnotation, MarkdownAnnotationAnchor, MarkdownAnnotationTarget } from '@proma/shared'
import type { QuotedSelection } from '@/atoms/preview-atoms'

/** 前后各取多少字符作为消歧上下文。 */
const ANCHOR_CONTEXT_CHARS = 32
/** 与「为 Agent 引用」一致的引文上限。 */
export const MAX_ANNOTATION_QUOTE_CHARS = 2000

function clampRange(doc: Text, from: number, to: number): { from: number; to: number } {
  const safeFrom = Math.max(0, Math.min(from, doc.length))
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length))
  return { from: safeFrom, to: safeTo }
}

/** 由文档与选区偏移构建完整锚点（引文、上下文与行号）；首尾空白不计入锚点。 */
export function createMarkdownAnnotationAnchor(doc: Text, rawFrom: number, rawTo: number): MarkdownAnnotationAnchor {
  const clamped = clampRange(doc, Math.min(rawFrom, rawTo), Math.max(rawFrom, rawTo))
  const raw = doc.sliceString(clamped.from, clamped.to)
  const leading = raw.length - raw.trimStart().length
  const trailing = raw.length - raw.trimEnd().length
  const from = Math.min(clamped.from + leading, clamped.to)
  const to = Math.max(from, clamped.to - trailing)
  return {
    from,
    to,
    exact: doc.sliceString(from, to),
    prefix: doc.sliceString(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    suffix: doc.sliceString(to, Math.min(doc.length, to + ANCHOR_CONTEXT_CHARS)),
    startLine: doc.lineAt(from).number,
    endLine: doc.lineAt(to).number,
  }
}

function refreshAnchorAt(doc: Text, anchor: MarkdownAnnotationAnchor, from: number, to: number): MarkdownAnnotationAnchor {
  return {
    ...anchor,
    from,
    to,
    exact: doc.sliceString(from, to),
    prefix: doc.sliceString(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    suffix: doc.sliceString(to, Math.min(doc.length, to + ANCHOR_CONTEXT_CHARS)),
    startLine: doc.lineAt(from).number,
    endLine: doc.lineAt(to).number,
  }
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = []
  if (!needle) return positions
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    positions.push(index)
    index = haystack.indexOf(needle, index + 1)
  }
  return positions
}

function contextScore(content: string, position: number, anchor: MarkdownAnnotationAnchor): number {
  const before = content.slice(Math.max(0, position - anchor.prefix.length), position)
  const after = content.slice(position + anchor.exact.length, position + anchor.exact.length + anchor.suffix.length)
  let score = 0
  // 从锚点向外逐字符比较，越贴近锚点的上下文权重越高。
  for (let index = 0; index < anchor.prefix.length; index += 1) {
    if (before[before.length - 1 - index] !== anchor.prefix[anchor.prefix.length - 1 - index]) break
    score += 1
  }
  for (let index = 0; index < anchor.suffix.length; index += 1) {
    if (after[index] !== anchor.suffix[index]) break
    score += 1
  }
  return score
}

/**
 * 在新文档中重新定位锚点：
 * 1. 原偏移处文本未变 → 直接沿用；
 * 2. 引文在文档中唯一或可凭上下文消歧 → 平移锚点；
 * 3. 找不到 → 标记 outdated，保留引文快照供面板展示与发送。
 */
export function relocateMarkdownAnnotation(doc: Text, annotation: MarkdownAnnotation): MarkdownAnnotation {
  const { anchor } = annotation
  const exact = anchor.exact
  if (!exact) return annotation.status === 'outdated' ? annotation : { ...annotation, status: 'outdated' }

  const { from, to } = clampRange(doc, anchor.from, anchor.to)
  if (to - from === exact.length && doc.sliceString(from, to) === exact) {
    const refreshed = refreshAnchorAt(doc, anchor, from, to)
    const status = annotation.status === 'outdated' ? 'open' : annotation.status
    if (status === annotation.status && sameAnchor(refreshed, anchor)) return annotation
    return { ...annotation, anchor: refreshed, status }
  }

  const content = doc.toString()
  const candidates = findAllOccurrences(content, exact)
  if (candidates.length === 0) {
    return annotation.status === 'outdated' ? annotation : { ...annotation, status: 'outdated' }
  }

  let best = candidates[0]!
  if (candidates.length > 1) {
    let bestScore = -1
    for (const candidate of candidates) {
      const score = contextScore(content, candidate, anchor)
      const closer = Math.abs(candidate - anchor.from) < Math.abs(best - anchor.from)
      if (score > bestScore || (score === bestScore && closer)) {
        best = candidate
        bestScore = score
      }
    }
  }
  return {
    ...annotation,
    anchor: refreshAnchorAt(doc, anchor, best, best + exact.length),
    status: annotation.status === 'outdated' ? 'open' : annotation.status,
  }
}

function sameAnchor(left: MarkdownAnnotationAnchor, right: MarkdownAnnotationAnchor): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.exact === right.exact
    && left.prefix === right.prefix
    && left.suffix === right.suffix
    && left.startLine === right.startLine
    && left.endLine === right.endLine
}

/** 整文替换（watcher 重载、外部写回）没有可信的增量映射，改走重定位。 */
export function isFullDocumentReplacement(changes: ChangeDesc, previousLength: number): boolean {
  if (changes.empty) return false
  let coversAll = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === previousLength) coversAll = true
  })
  return coversAll
}

/**
 * 同一编辑会话内的文档变更：用 CodeMirror 的 change mapping 平移锚点；
 * 锚文本被删除（TrackDel 返回 null）或整文替换时回退到引文重定位。
 */
export function mapMarkdownAnnotationsThroughChanges(
  annotations: readonly MarkdownAnnotation[],
  changes: ChangeDesc,
  previousLength: number,
  doc: Text,
): MarkdownAnnotation[] {
  if (changes.empty) return [...annotations]
  if (isFullDocumentReplacement(changes, previousLength)) {
    return annotations.map((annotation) => relocateMarkdownAnnotation(doc, annotation))
  }
  return annotations.map((annotation) => {
    if (annotation.status === 'outdated') return relocateMarkdownAnnotation(doc, annotation)
    const from = changes.mapPos(annotation.anchor.from, 1, MapMode.TrackDel)
    const to = changes.mapPos(annotation.anchor.to, -1, MapMode.TrackDel)
    if (from === null || to === null || to < from) {
      return relocateMarkdownAnnotation(doc, annotation)
    }
    const text = doc.sliceString(from, to)
    if (text !== annotation.anchor.exact) {
      // 锚文本内部被改写：跟随新文本继续存在，避免用户每敲一个字就丢批注。
      if (!text.trim()) return relocateMarkdownAnnotation(doc, annotation)
      return { ...annotation, anchor: { ...refreshAnchorAt(doc, annotation.anchor, from, to), exact: text } }
    }
    return { ...annotation, anchor: refreshAnchorAt(doc, annotation.anchor, from, to) }
  })
}

/** 面板与行内序号统一按文档顺序排列；失效批注沉底但保持创建顺序。 */
export function sortMarkdownAnnotations(annotations: readonly MarkdownAnnotation[]): MarkdownAnnotation[] {
  return [...annotations].sort((left, right) => {
    const leftOutdated = left.status === 'outdated'
    const rightOutdated = right.status === 'outdated'
    if (leftOutdated !== rightOutdated) return leftOutdated ? 1 : -1
    if (leftOutdated) return left.createdAt - right.createdAt
    return left.anchor.from - right.anchor.from || left.anchor.to - right.anchor.to || left.createdAt - right.createdAt
  })
}

/** 复用既有 quoted_file 引用协议：引文 + 行号进入 XML 块，评论作为紧随其后的正文。 */
export function buildMarkdownAnnotationQuote(
  annotation: MarkdownAnnotation,
  filePath: string,
  sourceLabel: string | undefined,
  capturedAt: number,
): QuotedSelection {
  const text = annotation.anchor.exact.length > MAX_ANNOTATION_QUOTE_CHARS
    ? annotation.anchor.exact.slice(0, MAX_ANNOTATION_QUOTE_CHARS)
    : annotation.anchor.exact
  return {
    text,
    filePath,
    sourceType: 'file',
    ...(sourceLabel && { sourceLabel }),
    startLine: annotation.anchor.startLine,
    endLine: annotation.anchor.endLine,
    capturedAt,
  }
}

/** 批注评论进入草稿时的展示前缀，帮助 Agent 区分引文与用户意见。 */
export function buildMarkdownAnnotationDraftText(annotation: MarkdownAnnotation): string {
  const comment = annotation.comment.trim()
  return comment ? `批注：${comment}` : '批注：（未填写评论）'
}

/** Jotai atomFamily 与持久化共用的稳定 key。 */
export function getMarkdownAnnotationFileKey(target: MarkdownAnnotationTarget): string {
  return target.kind === 'vault' ? `vault:${target.relativePath}` : `file:${target.filePath}`
}

/** 行内 Tag 的悬停/无障碍摘要。 */
export function summarizeMarkdownAnnotation(annotation: MarkdownAnnotation, maxChars = 60): string {
  const single = annotation.comment.replace(/\s+/g, ' ').trim()
  if (!single) return '（未填写评论）'
  const chars = Array.from(single)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : single
}

/** 行内 Tag 与面板共用的序号：按排序后的顺序编号，失效批注不占号。 */
export function numberMarkdownAnnotations(sorted: readonly MarkdownAnnotation[]): Map<string, number | null> {
  const numbers = new Map<string, number | null>()
  let next = 1
  for (const annotation of sorted) {
    if (annotation.status === 'outdated') {
      numbers.set(annotation.id, null)
      continue
    }
    numbers.set(annotation.id, next)
    next += 1
  }
  return numbers
}

/** 注水/回写时判断编辑器内状态是否已与 atom 一致，避免无意义的 dispatch 回环。 */
export function areMarkdownAnnotationListsEqual(
  left: readonly MarkdownAnnotation[],
  right: readonly MarkdownAnnotation[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a === b) continue
    if (a.id !== b.id || a.status !== b.status || a.comment !== b.comment || a.updatedAt !== b.updatedAt) return false
    if (!sameAnchor(a.anchor, b.anchor)) return false
  }
  return true
}
