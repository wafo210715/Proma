import { describe, expect, test } from 'bun:test'
import { stripCodeBlocks, isTextBeyondCollapseLines } from './sticky-user-message'

describe('悬浮置顶条 code block 摘要化', () => {
  test('given 含单个 fenced code block 的文本 when 摘要化 then 替换为占位符并保留其余文本', () => {
    expect(stripCodeBlocks('先看这段：\n```ts\nconst a = 1\n```\n以上是代码')).toBe('先看这段：\n [code] \n以上是代码')
  })

  test('given 含多个 code block 的文本 when 摘要化 then 全部替换为占位符', () => {
    expect(stripCodeBlocks('```js\na\n```\n中间说明\n```py\nb\n```')).toBe(' [code] \n中间说明\n [code] ')
  })

  test('given 无 code block 的普通文本 when 摘要化 then 原样返回', () => {
    expect(stripCodeBlocks('普通消息，无代码')).toBe('普通消息，无代码')
  })

  test('given 未闭合的单个 fence when 摘要化 then 不替换（避免误吞正文）', () => {
    expect(stripCodeBlocks('```\n未闭合内容')).toBe('```\n未闭合内容')
  })
})

describe('悬浮置顶条正文折叠判定', () => {
  test('given 全文高度超过两行加容差 when 判定 then 需要折叠并可展开', () => {
    expect(isTextBeyondCollapseLines({ scrollHeight: 67, lineHeight: 22 })).toBe(true)
  })

  test('given 全文高度恰好两行以内 when 判定 then 无需折叠', () => {
    expect(isTextBeyondCollapseLines({ scrollHeight: 44, lineHeight: 22 })).toBe(false)
    expect(isTextBeyondCollapseLines({ scrollHeight: 48, lineHeight: 22 })).toBe(false)
  })

  test('given 自定义行数阈值 when 判定 then 按传入行数计算', () => {
    expect(isTextBeyondCollapseLines({ scrollHeight: 70, lineHeight: 22, maxLines: 3 })).toBe(false)
    expect(isTextBeyondCollapseLines({ scrollHeight: 71, lineHeight: 22, maxLines: 3 })).toBe(true)
  })
})
