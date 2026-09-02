import { describe, expect, test } from 'bun:test'
import { ChangeSet, Text } from '@codemirror/state'
import type { MarkdownAnnotation } from '@proma/shared'
import {
  areMarkdownAnnotationListsEqual,
  buildMarkdownAnnotationDraftText,
  buildMarkdownAnnotationQuote,
  createMarkdownAnnotationAnchor,
  getMarkdownAnnotationFileKey,
  isFullDocumentReplacement,
  mapMarkdownAnnotationsThroughChanges,
  numberMarkdownAnnotations,
  relocateMarkdownAnnotation,
  sortMarkdownAnnotations,
} from './markdown-annotations'

const SOURCE = [
  '# 标题',
  '',
  '第一段讲背景，提出问题。',
  '',
  '第二段给出方法，解释细节。',
  '',
  '第三段回答了第一段的疑问。',
].join('\n')

function doc(content: string): Text {
  return Text.of(content.split('\n'))
}

function annotationAt(content: string, needle: string, comment = '这里有疑问'): MarkdownAnnotation {
  const from = content.indexOf(needle)
  if (from === -1) throw new Error(`fixture 缺少文本: ${needle}`)
  const text = doc(content)
  return {
    id: `anno-${needle}`,
    anchor: createMarkdownAnnotationAnchor(text, from, from + needle.length),
    comment,
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Markdown 批注锚点', () => {
  test('given 选区偏移 when 创建锚点 then 记录引文、上下文与 1-based 行号', () => {
    const annotation = annotationAt(SOURCE, '提出问题')
    expect(annotation.anchor.exact).toBe('提出问题')
    expect(annotation.anchor.prefix.endsWith('讲背景，')).toBe(true)
    expect(annotation.anchor.suffix.startsWith('。')).toBe(true)
    expect(annotation.anchor.startLine).toBe(3)
    expect(annotation.anchor.endLine).toBe(3)
  })

  test('given 反向选区 when 创建锚点 then 自动归一为正向范围', () => {
    const text = doc(SOURCE)
    const from = SOURCE.indexOf('提出问题')
    const anchor = createMarkdownAnnotationAnchor(text, from + 4, from)
    expect(anchor.exact).toBe('提出问题')
  })
})

describe('同一编辑会话内随编辑映射', () => {
  test('given 锚点上方插入文本 when 映射 then 偏移平移且引文不变', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const insertAt = SOURCE.indexOf('第一段')
    const changes = ChangeSet.of({ from: insertAt, insert: '（新增前言）' }, SOURCE.length)
    const next = mapMarkdownAnnotationsThroughChanges([annotation], changes, SOURCE.length, doc(changes.apply(doc(SOURCE)).toString()))
    expect(next[0]!.anchor.from).toBe(annotation.anchor.from + '（新增前言）'.length)
    expect(next[0]!.anchor.exact).toBe('给出方法')
    expect(next[0]!.status).toBe('open')
  })

  test('given 锚文本内部改写 when 映射 then 跟随新文本而不是丢失批注', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const at = SOURCE.indexOf('方法')
    const changes = ChangeSet.of({ from: at, to: at + 2, insert: '路径' }, SOURCE.length)
    const after = changes.apply(doc(SOURCE))
    const next = mapMarkdownAnnotationsThroughChanges([annotation], changes, SOURCE.length, after)
    expect(next[0]!.anchor.exact).toBe('给出路径')
    expect(next[0]!.status).toBe('open')
  })

  test('given 锚文本整段删除 when 映射 then 标记 outdated 并保留引文快照', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const lineStart = SOURCE.indexOf('第二段')
    const lineEnd = SOURCE.indexOf('\n', lineStart)
    const changes = ChangeSet.of({ from: lineStart, to: lineEnd, insert: '' }, SOURCE.length)
    const next = mapMarkdownAnnotationsThroughChanges([annotation], changes, SOURCE.length, changes.apply(doc(SOURCE)))
    expect(next[0]!.status).toBe('outdated')
    expect(next[0]!.anchor.exact).toBe('给出方法')
  })

  test('given 整文替换 when 映射 then 按引文重定位而非全部失效', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const replaced = `前置说明\n\n${SOURCE}`
    const changes = ChangeSet.of({ from: 0, to: SOURCE.length, insert: replaced }, SOURCE.length)
    expect(isFullDocumentReplacement(changes, SOURCE.length)).toBe(true)
    const next = mapMarkdownAnnotationsThroughChanges([annotation], changes, SOURCE.length, doc(replaced))
    expect(next[0]!.status).toBe('open')
    expect(next[0]!.anchor.from).toBe(replaced.indexOf('给出方法'))
    expect(next[0]!.anchor.startLine).toBe(7)
  })
})

describe('跨会话重定位', () => {
  test('given 文档未变 when 重定位 then 原对象原样返回', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    expect(relocateMarkdownAnnotation(doc(SOURCE), annotation)).toBe(annotation)
  })

  test('given 引文唯一但位置漂移 when 重定位 then 平移到新位置', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const shifted = SOURCE.replace('第一段讲背景，提出问题。', '第一段讲背景，提出问题，并补充了大量的动机描述。')
    const next = relocateMarkdownAnnotation(doc(shifted), annotation)
    expect(next.status).toBe('open')
    expect(next.anchor.from).toBe(shifted.indexOf('给出方法'))
    expect(next.anchor.exact).toBe('给出方法')
  })

  test('given 引文多处出现 when 重定位 then 依靠前后文消歧', () => {
    const annotation = annotationAt(SOURCE, '第一段的疑问')
    const duplicated = SOURCE.replace('# 标题', '# 标题\n\n引言里先抛出第一段的疑问作为悬念。')
    const next = relocateMarkdownAnnotation(doc(duplicated), annotation)
    expect(next.anchor.from).toBe(duplicated.lastIndexOf('第一段的疑问'))
    expect(next.status).toBe('open')
  })

  test('given 引文已不存在 when 重定位 then 标记 outdated', () => {
    const annotation = annotationAt(SOURCE, '给出方法')
    const removed = SOURCE.replace('第二段给出方法，解释细节。', '第二段已重写。')
    const next = relocateMarkdownAnnotation(doc(removed), annotation)
    expect(next.status).toBe('outdated')
    expect(next.anchor.exact).toBe('给出方法')
  })

  test('given 已失效批注的引文重新出现 when 重定位 then 恢复为 open', () => {
    const annotation: MarkdownAnnotation = { ...annotationAt(SOURCE, '给出方法'), status: 'outdated' }
    const next = relocateMarkdownAnnotation(doc(SOURCE), annotation)
    expect(next.status).toBe('open')
  })

  test('given 已发送批注 when 重定位 then 保留 sent 状态', () => {
    const annotation: MarkdownAnnotation = { ...annotationAt(SOURCE, '给出方法'), status: 'sent' }
    const shifted = `新增一行\n${SOURCE}`
    expect(relocateMarkdownAnnotation(doc(shifted), annotation).status).toBe('sent')
  })
})

describe('排序与发送', () => {
  test('given 混合状态 when 排序 then 按文档顺序、失效沉底', () => {
    const first = annotationAt(SOURCE, '提出问题')
    const second = annotationAt(SOURCE, '给出方法')
    const stale: MarkdownAnnotation = { ...annotationAt(SOURCE, '第一段的疑问'), status: 'outdated', createdAt: 0 }
    const sorted = sortMarkdownAnnotations([stale, second, first])
    expect(sorted.map((item) => item.id)).toEqual([first.id, second.id, stale.id])
  })

  test('given 批注 when 转为引用 then 携带路径、来源与行号', () => {
    const annotation = annotationAt(SOURCE, '给出方法', '这里需要引用文献')
    const quote = buildMarkdownAnnotationQuote(annotation, '/notes/a.md', 'Obsidian · a.md', 42)
    expect(quote).toEqual({
      text: '给出方法',
      filePath: '/notes/a.md',
      sourceType: 'file',
      sourceLabel: 'Obsidian · a.md',
      startLine: 5,
      endLine: 5,
      capturedAt: 42,
    })
    expect(buildMarkdownAnnotationDraftText(annotation)).toBe('批注：这里需要引用文献')
  })

  test('given 空评论 when 生成草稿文案 then 给出占位说明', () => {
    const annotation = annotationAt(SOURCE, '给出方法', '   ')
    expect(buildMarkdownAnnotationDraftText(annotation)).toBe('批注：（未填写评论）')
  })

  test('given 文件与 Vault 目标 when 生成 key then 互不冲突', () => {
    expect(getMarkdownAnnotationFileKey({ kind: 'file', filePath: '/a.md' })).toBe('file:/a.md')
    expect(getMarkdownAnnotationFileKey({ kind: 'vault', relativePath: 'a.md' })).toBe('vault:a.md')
  })
})

describe('序号与相等性', () => {
  test('given 排序后的列表 when 编号 then 失效批注不占号', () => {
    const first = annotationAt(SOURCE, '提出问题')
    const second = annotationAt(SOURCE, '给出方法')
    const stale: MarkdownAnnotation = { ...annotationAt(SOURCE, '第一段的疑问'), status: 'outdated' }
    const numbers = numberMarkdownAnnotations(sortMarkdownAnnotations([stale, second, first]))
    expect(numbers.get(first.id)).toBe(1)
    expect(numbers.get(second.id)).toBe(2)
    expect(numbers.get(stale.id)).toBeNull()
  })

  test('given 内容相同但对象不同的列表 when 比较 then 视为相等；任一字段变化则不等', () => {
    const base = annotationAt(SOURCE, '给出方法')
    expect(areMarkdownAnnotationListsEqual([base], [{ ...base, anchor: { ...base.anchor } }])).toBe(true)
    expect(areMarkdownAnnotationListsEqual([base], [{ ...base, comment: '改了' }])).toBe(false)
    expect(areMarkdownAnnotationListsEqual([base], [{ ...base, anchor: { ...base.anchor, from: base.anchor.from + 1 } }])).toBe(false)
    expect(areMarkdownAnnotationListsEqual([base], [])).toBe(false)
  })
})

describe('选区空白处理', () => {
  test('given 选区带首尾空白 when 创建锚点 then 锚点收缩到正文', () => {
    const text = doc(SOURCE)
    const start = SOURCE.indexOf('提出问题')
    const anchor = createMarkdownAnnotationAnchor(text, start - 0, start + '提出问题。\n\n'.length)
    expect(anchor.exact).toBe('提出问题。')
    expect(anchor.endLine).toBe(3)
  })
})
