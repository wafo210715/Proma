import { describe, expect, test } from 'bun:test'
import { stripCodeBlocks } from './sticky-user-message'

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
