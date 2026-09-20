import { describe, expect, test } from 'bun:test'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  buildAgentHistoryQuoteLabel,
  buildQuotedSelectionChipMeta,
  buildQuotedSelectionLabel,
  expandAgentHistoryQuoteMentions,
  parseQuotedSelectionMention,
  parseQuotedSelectionRefs,
  serializeAgentHistoryQuoteMention,
  serializeQuotedSelectionMention,
} from './quoted-selection'

function buildHistoryQuote(overrides: Partial<QuotedSelection> = {}): QuotedSelection {
  return {
    text: '联网调研并对比两个模型，信息必须来自网上最新公开资料。',
    filePath: 'Agent 历史 · Agent 回复',
    sourceType: 'agent-history',
    sourceLabel: 'Agent 历史 · Agent 回复',
    messageId: 'msg-1',
    messageRole: 'assistant',
    selectionStart: 10,
    selectionEnd: 35,
    turn: 9,
    capturedAt: 0,
    ...overrides,
  }
}

function buildFileQuote(overrides: Partial<QuotedSelection> = {}): QuotedSelection {
  return {
    text: 'file node = 一篇文献，指向它的 MD note。',
    filePath: '/repo/notes/canvas.md',
    sourceType: 'file',
    capturedAt: 0,
    ...overrides,
  }
}

describe('引用 chip 短摘要：省略号与字数信号', () => {
  test('短文本不加省略号，字数按码点计数', () => {
    const label = buildAgentHistoryQuoteLabel({ text: '你好世界', turn: 3 })
    expect(label).toBe('第3轮 · 4 字 · 你好世界')
  })

  test('长文本截断到预览上限并追加省略号，字数为全文码点数', () => {
    const text = 'pi 的内建 compaction：把全量历史发给 LLM，用结构化提示词生成 summary。'
    const label = buildAgentHistoryQuoteLabel({ text, turn: 16 })
    expect(label).toContain(' · ')
    expect(label.startsWith('第16轮 · ')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    // 字数 = 全文码点数（未折叠空白），而不是预览长度
    const count = Array.from(text).length
    expect(label).toContain(` · ${count} 字 · `)
  })

  test('缺 turn 时回退为“历史引用”前缀', () => {
    const label = buildAgentHistoryQuoteLabel({ text: '短' })
    expect(label.startsWith('历史引用 · ')).toBe(true)
  })

  test('emoji 按码点计 1 个字', () => {
    const label = buildAgentHistoryQuoteLabel({ text: '🎉✨🚀', turn: 1 })
    expect(label).toBe('第1轮 · 3 字 · 🎉✨🚀')
  })

  test('文件引用 label 使用文件名前缀', () => {
    const label = buildQuotedSelectionLabel(buildFileQuote())
    expect(label.startsWith('canvas.md · ')).toBe(true)
    expect(label).toContain(' 字 · ')
  })
})

describe('引用 chip meta 与块状布局判定', () => {
  test('meta 行 = 来源 · 字数', () => {
    expect(buildQuotedSelectionChipMeta(buildHistoryQuote())).toBe('第9轮 · 27 字')
    expect(buildQuotedSelectionChipMeta(buildFileQuote())).toBe('canvas.md · 30 字')
  })
})

describe('payload 往返保真（发送内容完整性）', () => {
  test('Agent 历史引用 v1 marker 往返不丢内容', () => {
    const quote = buildHistoryQuote({ text: '第一行\n第二行\t带缩进\n🎉 emoji' })
    const marker = serializeAgentHistoryQuoteMention(quote)
    expect(marker).not.toBeNull()
    const parsed = parseQuotedSelectionMention(marker!)
    expect(parsed?.text).toBe(quote.text)
    expect(parsed?.sourceType).toBe('agent-history')
    expect(parsed?.turn).toBe(9)
  })

  test('文件引用 v2 marker 往返不丢内容', () => {
    const quote = buildFileQuote({ text: '多行\n引用</quoted_file> 含闭合标签' })
    const marker = serializeQuotedSelectionMention(quote)
    expect(marker).not.toBeNull()
    const parsed = parseQuotedSelectionMention(marker!)
    expect(parsed?.text).toBe(quote.text)
    expect(parsed?.sourceType).toBe('file')
    expect(parsed?.filePath).toBe(quote.filePath)
  })

  test('非法 version 与缺字段 payload 解析为 null', () => {
    const bad = `&quote:${encodeURIComponent(JSON.stringify({ version: 99, text: 'x', filePath: 'y', sourceType: 'file' }))}`
    expect(parseQuotedSelectionMention(bad)).toBeNull()
  })

  test('marker 展开为 XML 块时正文长度与输入一致（不截断）', () => {
    const text = Array.from({ length: 120 }, (_, i) => `第${i}行内容`).join('\n')
    const quote = buildHistoryQuote({ text, selectionStart: 0, selectionEnd: text.length })
    const expanded = expandAgentHistoryQuoteMentions(`前置 ${serializeAgentHistoryQuoteMention(quote)} 后置`)
    expect(expanded).toContain('<quoted_context')
    const body = expanded.match(/<quoted_context[^>]*>\n([\s\S]*?)\n<\/quoted_context>/)?.[1]
    expect(body).toBe(text)
  })
})

describe('已发送消息解析：引用块正文提取（展开全量的数据来源）', () => {
  test('解析 quoted_file 块时保留正文', () => {
    const content = '<quoted_file path="/repo/notes/a.md">\n第一行\n第二行\n</quoted_file>\n\n问题在这里'
    const { quotes, text } = parseQuotedSelectionRefs(content)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]?.sourceType).toBe('file')
    expect(quotes[0]?.text).toBe('第一行\n第二行')
    expect(text).toBe('问题在这里')
  })

  test('解析 quoted_context 块时保留正文与定位元数据', () => {
    const content = [
      '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="m1" role="assistant" turn="2" selection_start="5" selection_end="25">',
      '被引用的历史正文',
      '</quoted_context>',
      '',
      '正文提问',
    ].join('\n')
    const { quotes, text } = parseQuotedSelectionRefs(content)
    expect(quotes[0]?.text).toBe('被引用的历史正文')
    expect(quotes[0]?.quote?.turn).toBe(2)
    expect(text).toBe('正文提问')
  })
})
