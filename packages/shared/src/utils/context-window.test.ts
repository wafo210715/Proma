import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONTEXT_WINDOW, ONE_MILLION_CONTEXT_WINDOW, inferContextWindow } from './context-window'

describe('模型上下文窗口推断', () => {
  test('given 未识别模型 when 推断上下文窗口 then 使用 256 Ki token 默认值', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(262_144)
    expect(inferContextWindow('unknown-model')).toBe(262_144)
  })

  test('given 已知 1M 模型 when 推断上下文窗口 then 保持模型专属窗口', () => {
    expect(inferContextWindow('claude-sonnet-5')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })
})
