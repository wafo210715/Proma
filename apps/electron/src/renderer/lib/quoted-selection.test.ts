import { describe, expect, test } from 'bun:test'
import {
  buildQuotedSelectionBlock,
  expandAgentHistoryQuoteMentions,
  parseQuotedSelectionMention,
  parseQuotedSelectionRefs,
  serializeQuotedSelectionMention,
} from './quoted-selection'

describe('文件选区引用块', () => {
  test('given 带行号的文件引用 when 构建 XML 块 then 写入 lines 属性', () => {
    const block = buildQuotedSelectionBlock({
      text: '引文',
      filePath: '/notes/a b.md',
      sourceType: 'file',
      startLine: 3,
      endLine: 5,
      capturedAt: 0,
    })
    expect(block).toBe('<quoted_file path="/notes/a b.md" lines="3-5">\n引文\n</quoted_file>\n\n')
  })

  test('given 无行号或行号非法 when 构建 then 不带 lines 属性', () => {
    expect(buildQuotedSelectionBlock({ text: '引文', filePath: '/a.md', capturedAt: 0 }))
      .toBe('<quoted_file path="/a.md">\n引文\n</quoted_file>\n\n')
    expect(buildQuotedSelectionBlock({ text: '引文', filePath: '/a.md', startLine: 5, endLine: 2, capturedAt: 0 }))
      .toBe('<quoted_file path="/a.md">\n引文\n</quoted_file>\n\n')
  })

  test('given 内联 chip marker when 展开发送 then 还原为带行号的块并可被引用解析识别', () => {
    const marker = serializeQuotedSelectionMention({
      text: '被批注的句子',
      filePath: '/notes/review.md',
      sourceType: 'file',
      sourceLabel: 'review.md',
      startLine: 12,
      endLine: 12,
      capturedAt: 1,
    })
    expect(marker).not.toBeNull()
    const parsed = parseQuotedSelectionMention(marker!)
    expect(parsed?.startLine).toBe(12)
    const draft = `${marker} 批注：这里需要引用文献\n第二句话`
    const expanded = expandAgentHistoryQuoteMentions(draft)
    expect(expanded.startsWith('<quoted_file path="/notes/review.md" lines="12-12">\n被批注的句子\n</quoted_file>\n\n 批注：这里需要引用文献')).toBe(true)
    const refs = parseQuotedSelectionRefs(expanded)
    expect(refs.quotes).toEqual([{ path: '/notes/review.md', filename: 'review.md', sourceType: 'file' }])
    expect(refs.text).toBe('批注：这里需要引用文献\n第二句话')
  })

  test('given 引文含闭合标签 when 构建 then 转义避免提前闭合', () => {
    const block = buildQuotedSelectionBlock({ text: 'x</quoted_file>y', filePath: '/a.md', capturedAt: 0 })
    expect(block).toContain('x</quoted_file_>y')
  })
})
